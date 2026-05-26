#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="$ROOT_DIR/dist/API for Cursor.app"
TIMEOUT_SECONDS=45
RUN_PACKAGE=0
PACKAGE_MODE="--release"
RUN_TESTS=1
REQUIRE_LIVE=0

usage() {
  cat <<USAGE
Usage: $0 [--app PATH] [--timeout SECONDS] [--package] [--development-package] [--skip-tests] [--require-live]

Run the release-quality verification gate for the packaged macOS app. The gate
is intentionally sequential because the provider smoke tests launch and quit the
same app bundle.

  --app PATH       App bundle to verify. Defaults to dist/API for Cursor.app.
  --timeout N      Seconds for each app/provider smoke. Default: 45.
  --package        Rebuild the release app bundle before verification.
  --development-package
                   Rebuild a development app bundle before verification.
  --skip-tests     Skip swift test.
  --require-live   Fail unless CURSOR_API_TEST_KEY is set and live routing passes.

When CURSOR_API_TEST_KEY is set, this also runs the live routing smoke check.
Without a key, the live check is skipped unless --require-live is set.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app)
      APP_PATH="${2:-}"
      [ -n "$APP_PATH" ] || { echo "--app requires a path" >&2; exit 64; }
      shift
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      [ -n "$TIMEOUT_SECONDS" ] || { echo "--timeout requires seconds" >&2; exit 64; }
      shift
      ;;
    --package)
      RUN_PACKAGE=1
      PACKAGE_MODE="--release"
      ;;
    --development-package)
      RUN_PACKAGE=1
      PACKAGE_MODE="--development"
      ;;
    --skip-tests)
      RUN_TESTS=0
      ;;
    --require-live)
      REQUIRE_LIVE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

fail() {
  echo "Release smoke gate failed: $*" >&2
  exit 1
}

stop_app() {
  osascript -e 'tell application id "ai.standardagents.cursorapi" to quit' >/dev/null 2>&1 || true
  pkill -f 'cursor-sdk-opencode-bridge.mjs' >/dev/null 2>&1 || true
}

run_with_timeout() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  local deadline=$((SECONDS + seconds))
  while kill -0 "$pid" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 0.5
  done
  wait "$pid"
}

run_step() {
  local label="$1"
  local seconds="$2"
  shift 2
  printf '\n==> %s\n' "$label"
  run_with_timeout "$seconds" "$@"
}

run_app_step() {
  local label="$1"
  shift
  stop_app
  run_step "$label" "$((TIMEOUT_SECONDS + 45))" "$@"
  stop_app
}

trap stop_app EXIT

if [ "$RUN_PACKAGE" -eq 1 ]; then
  run_step "Package app" 240 "$ROOT_DIR/Scripts/package-app.sh" "$PACKAGE_MODE"
fi

if [ "$RUN_TESTS" -eq 1 ]; then
  run_step "Swift tests" 300 swift test --package-path "$ROOT_DIR"
fi

run_step "Verify package" 60 "$ROOT_DIR/Scripts/verify-package.sh" "$APP_PATH"
run_app_step "App window and health smoke" "$ROOT_DIR/Scripts/smoke-app.sh" --app "$APP_PATH" --require-server --timeout "$TIMEOUT_SECONDS"
run_app_step "Codex provider smoke" "$ROOT_DIR/Scripts/smoke-codex.sh" --app "$APP_PATH" --timeout "$TIMEOUT_SECONDS"
run_app_step "OpenCode provider smoke" "$ROOT_DIR/Scripts/smoke-opencode.sh" --app "$APP_PATH" --timeout "$TIMEOUT_SECONDS"
run_app_step "pi provider smoke" "$ROOT_DIR/Scripts/smoke-pi.sh" --app "$APP_PATH" --timeout "$TIMEOUT_SECONDS"

if [ -n "${CURSOR_API_TEST_KEY:-}" ]; then
  run_app_step "Live routing smoke" "$ROOT_DIR/Scripts/smoke-live-routing.sh" --app "$APP_PATH" --timeout "$TIMEOUT_SECONDS"
elif [ "$REQUIRE_LIVE" -eq 1 ]; then
  fail "CURSOR_API_TEST_KEY is required for --require-live"
else
  printf '\n==> Live routing smoke\n'
  echo "Skipping live routing smoke; set CURSOR_API_TEST_KEY to enable it."
fi

echo
echo "Release smoke gate passed."
