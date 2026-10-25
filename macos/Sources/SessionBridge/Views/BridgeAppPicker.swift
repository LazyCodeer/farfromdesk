import SwiftUI
import AppKit

/// Native popup behavior preserves keyboard navigation and a trailing menu arrow.
/// SwiftUI owns selection; rebuilding the menu never invokes onChange.
struct BridgeAppPicker: View {
    struct Option: Equatable { let id: String; let title: String }
    let options: [Option]
    let selection: String
    let onChange: (String) -> Void
    var body: some View {
        NativeAppPicker(options: options, selection: selection, onChange: onChange)
            .frame(width: width, height: 40)
            .accessibilityLabel("App")
    }
    private var width: CGFloat {
        let font = NSFont.systemFont(ofSize: 13, weight: .medium)
        let titleWidth = options.map { ($0.title as NSString).size(withAttributes: [.font: font]).width }.max() ?? 90
        return max(160, titleWidth + 54)
    }
}

struct NativeAppPicker: NSViewRepresentable {
    let options: [BridgeAppPicker.Option]
    let selection: String
    let onChange: (String) -> Void
    @Environment(\.isEnabled) private var isEnabled

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }
    func makeNSView(context: Context) -> NSPopUpButton {
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.controlSize = .large
        popup.bezelStyle = .rounded
        popup.font = .systemFont(ofSize: 13, weight: .medium)
        popup.appearance = NSAppearance(named: .darkAqua)
        popup.setAccessibilityLabel("App")
        popup.target = context.coordinator
        popup.action = #selector(Coordinator.changed(_:))
        return popup
    }
    func updateNSView(_ popup: NSPopUpButton, context: Context) {
        context.coordinator.onChange = onChange
        context.coordinator.update(popup, options: options, selection: selection, enabled: isEnabled)
    }

    final class Coordinator: NSObject {
        var onChange: (String) -> Void
        private var options: [BridgeAppPicker.Option] = []
        init(onChange: @escaping (String) -> Void) { self.onChange = onChange }
        func update(_ popup: NSPopUpButton, options: [BridgeAppPicker.Option], selection: String, enabled: Bool) {
            if self.options != options || popup.numberOfItems == 0 {
                self.options = options
                popup.removeAllItems()
                for option in options {
                    let item = NSMenuItem(title: option.title, action: nil, keyEquivalent: "")
                    item.representedObject = option.id
                    popup.menu?.addItem(item)
                }
                if options.isEmpty { popup.addItem(withTitle: "No apps found") }
            }
            popup.selectItem(at: options.isEmpty ? 0 : (options.firstIndex(where: { $0.id == selection }) ?? -1))
            popup.isEnabled = enabled && !options.isEmpty
        }
        @objc func changed(_ popup: NSPopUpButton) {
            guard popup.isEnabled, let id = popup.selectedItem?.representedObject as? String,
                  options.contains(where: { $0.id == id }) else { return }
            onChange(id)
        }
    }
}
