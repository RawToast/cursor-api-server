import CursorAPICore
import AppKit
import SwiftUI

@main
@MainActor
final class CursorAPIAppDelegate: NSObject, NSApplicationDelegate {
    private static var retainedDelegate: CursorAPIAppDelegate?

    private let model = CursorAPIAppModel()
    private var mainWindow: NSWindow?

    static func main() {
        let app = NSApplication.shared
        let delegate = CursorAPIAppDelegate()
        retainedDelegate = delegate
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.finishLaunching()
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        revealMainWindow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        revealMainWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func revealMainWindow() {
        NSApp.setActivationPolicy(.regular)
        if let window = mainWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 893, height: 592),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = CursorAPIBrand.displayName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 560)
        window.contentViewController = NSHostingController(rootView: CursorAPIAppRootView(model: model))
        window.center()
        window.makeKeyAndOrderFront(nil)
        mainWindow = window
        NSApp.activate(ignoringOtherApps: true)
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit \(CursorAPIBrand.displayName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        NSApp.mainMenu = mainMenu
    }
}

private struct CursorAPIAppRootView: View {
    @ObservedObject var model: CursorAPIAppModel

    var body: some View {
        ContentView(model: model)
            .frame(minWidth: 760, minHeight: 560)
            .task {
                model.startServer(allowKeychainPrompt: false)
            }
    }
}
