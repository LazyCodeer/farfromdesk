import Testing
import SwiftUI
import AppKit
@testable import SessionBridge

@MainActor
struct ControlInteractionTests {
    @Test func nativeAppPickerKeepsExactSelectionWithoutFiringDuringRefresh() {
        let options = [BridgeAppPicker.Option(id: "codex:desktop", title: "Codex Desktop"), .init(id: "claude:cli", title: "Claude CLI")]
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 190, height: 40), pullsDown: false)
        var changes: [String] = []
        let coordinator = NativeAppPicker.Coordinator { changes.append($0) }
        coordinator.update(popup, options: options, selection: "codex:desktop", enabled: true)
        #expect(popup.selectedItem?.representedObject as? String == "codex:desktop")
        #expect(changes.isEmpty)
        popup.selectItem(at: 1)
        coordinator.changed(popup)
        #expect(changes == ["claude:cli"])
        coordinator.update(popup, options: Array(options.reversed()), selection: "claude:cli", enabled: true)
        #expect(popup.selectedItem?.representedObject as? String == "claude:cli")
        #expect(changes.count == 1)
        coordinator.update(popup, options: options, selection: "claude:cli", enabled: false)
        coordinator.changed(popup)
        #expect(changes.count == 1)
        coordinator.update(popup, options: [], selection: "claude:cli", enabled: true)
        #expect(!popup.isEnabled)
        coordinator.changed(popup)
        #expect(changes.count == 1)
    }

}
