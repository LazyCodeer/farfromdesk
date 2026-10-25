import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct SessionBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var bridge = BridgeModel()
    var body: some Scene {
        Window("FarFromDesk", id: "main") {
            ContentView().environmentObject(bridge).task { bridge.start() }
        }
        .defaultSize(width: 1100, height: 780)
        .commands {
            CommandGroup(replacing: .newItem) {}
            BridgeSettingsCommands(bridge: bridge)
            CommandMenu("Bridge") {
                Button("Refresh Status") { Task { await bridge.refresh() } }.keyboardShortcut("r")
                Button("Show Sessions in WhatsApp") { Task { await bridge.command("/sessions") } }
                    .disabled(!bridge.connected)
            }
        }
        MenuBarExtra("FarFromDesk", systemImage: bridge.connected ? "message.badge.filled.fill" : "message") {
            MenuBarView().environmentObject(bridge)
        }
    }
}

struct MenuBarView: View {
    @EnvironmentObject var bridge: BridgeModel
    @Environment(\.openWindow) var openWindow
    var body: some View {
        Text(bridge.connected ? "WhatsApp connected" : "WhatsApp offline")
        Button("Open FarFromDesk") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button("Refresh Status") { Task { await bridge.refresh() } }
        Divider()
        Text(bridge.status?.preferences?.backgroundEnabled == true ? "Background operation enabled" : "Background operation paused")
        Button("Quit App") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

struct BridgeSettingsCommands: Commands {
    @ObservedObject var bridge: BridgeModel
    @Environment(\.openWindow) private var openWindow
    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") {
                bridge.page = .settings
                openWindow(id: "main")
                NSApp.activate(ignoringOtherApps: true)
            }.keyboardShortcut(",", modifiers: .command)
        }
    }
}
