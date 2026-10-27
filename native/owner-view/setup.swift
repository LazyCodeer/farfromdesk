// Included only in the separately packaged Owner View Test helper.
final class OwnerViewSetup: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var status: NSTextField!
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "FarFromDesk Owner View Test"
        let stack = NSStackView(); stack.orientation = .vertical; stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Isolated local test helper")
        title.font = .boldSystemFont(ofSize: 20)
        stack.addArrangedSubview(title)
        stack.addArrangedSubview(NSTextField(wrappingLabelWithString: "This is a permissions setup window, not production FarFromDesk. No messaging client, capture or input is running. Grant only this named test app. The viewer starts separately after readiness is checked."))
        status = NSTextField(wrappingLabelWithString: ""); stack.addArrangedSubview(status)
        for (name, action) in [("Check permissions", #selector(check)), ("Request Accessibility", #selector(accessibility)), ("Request Screen Recording", #selector(recording)), ("Close setup", #selector(closeSetup))] {
            stack.addArrangedSubview(NSButton(title: name, target: self, action: action))
        }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20)])
        check(); window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func check() {
        status.stringValue = "Accessibility: \(AXIsProcessTrusted() ? "allowed" : "not granted")  |  Screen Recording: \(CGPreflightScreenCaptureAccess() ? "allowed" : "not granted")"
    }
    @objc func accessibility() { _ = try? run(["action": "requestPermission"]); check() }
    @objc func recording() { _ = try? run(["action": "requestScreenRecording"]); check() }
    @objc func closeSetup() { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
func openOwnerViewSetup() {
    let app = NSApplication.shared; app.setActivationPolicy(.regular)
    let delegate = OwnerViewSetup(); app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
