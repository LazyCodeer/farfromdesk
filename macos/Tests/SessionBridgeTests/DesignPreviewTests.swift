import Testing
import SwiftUI
import AppKit
@testable import SessionBridge

// Opt-in component renders. Sample data only; no app lifecycle or network calls.
@MainActor
struct DesignPreviewTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["WSB_RENDER_PREVIEWS"] != nil))
    func renderDesignPreviews() throws {
        let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["WSB_RENDER_PREVIEWS"]!)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        _ = NSApplication.shared
        let model = BridgeModel()
        let fixture = #"{"requestCleanup":{"enabled":false,"afterHours":24},"voice":{"ready":true,"local":true,"bundled":true},"whatsapp":{"status":"connected","phoneNumber":"+15551234567"},"apps":[{"provider":"codex","name":"Codex","enabled":true,"sessions":12},{"provider":"claude","name":"Claude Code","enabled":true,"sessions":3}],"master":{"id":"master","name":"WhatsApp master","ready":true,"provider":"codex"},"selected":[{"name":"Website redesign","provider":"claude","id":"site"},{"name":"Add sign-in to the dashboard","provider":"codex","id":"auth"}],"bindings":[{"id":"master","alias":"whatsapp-master","provider":"codex","native_id":"native-master","enabled":1,"name":"WhatsApp master","running":false},{"id":"site","alias":"claude-website","provider":"claude","native_id":"native-site","enabled":1,"name":"Website redesign","running":false},{"id":"auth","alias":"codex-signin","provider":"codex","native_id":"native-auth","enabled":1,"name":"Sign-in flow","running":false}],"jobs":[{"id":"wa:sample1","binding_id":"site","status":"completed","created_at":1792873390671},{"id":"wa:sample2","binding_id":"auth","status":"completed","created_at":1792873370671},{"id":"wa:sample3","binding_id":"master","status":"completed","created_at":1792873300671}],"approvals":[],"preferences":{"backgroundEnabled":true,"keepAwake":false,"assertionActive":false},"destination":{"kind":"self","name":"Message yourself"},"masterSetup":{"platforms":[{"provider":"codex","label":"Codex · native CLI","available":true},{"provider":"claude","label":"Claude Code · background CLI","available":true}],"operation":null,"prompt":"Sample coordinator instructions."}}"#
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: Data(fixture.utf8))
        model.reachable = true
        model.installations = [InstalledAgent(id: "codex", name: "Codex", app: nil, cli: URL(fileURLWithPath: "/sample/codex")), InstalledAgent(id: "claude", name: "Claude Code", app: nil, cli: URL(fileURLWithPath: "/sample/claude"))]
        model.sessions = [CodingSession(id: "native-auth", name: "Sign-in flow", cwd: "/Projects/customer-portal", provider: "codex", status: "existing chat"), CodingSession(id: "native-notes", name: "Release notes for v2", cwd: "/Projects/customer-portal", provider: "codex", status: "existing chat")]

        model.recoveredGroups = [RecoveredGroups.Group(id: "sample-group", name: "Session Bridge")]
        model.groupsDiscovered = true
        for scheme in [ColorScheme.light, .dark] {
            let label = scheme == .light ? "light" : "dark"
            NSApp.appearance = NSAppearance(named: scheme == .light ? .aqua : .darkAqua)
            try render(ContentView(), model, scheme, directory.appendingPathComponent("window-\(label).png"), width: 1100, height: 780)
            try render(SettingsView(), model, scheme, directory.appendingPathComponent("settings-\(label).png"))
            model.page = .settings
            try render(ContentView(), model, scheme, directory.appendingPathComponent("settings-window-\(label).png"), width: 1100, height: 780)
            model.page = .whatsapp
            try render(BridgePage { MasterSetupView(compact: true) }, model, scheme, directory.appendingPathComponent("master-\(label).png"))
            try render(WhatsAppView(autoDiscoverGroups: false), model, scheme, directory.appendingPathComponent("whatsapp-\(label).png"))
        }
        try render(ContentView(), model, .light, directory.appendingPathComponent("window-compact.png"), width: 900, height: 640)
        try render(ActivityView(), model, .light, directory.appendingPathComponent("activity.png"))
        try render(SettingsView(), model, .light, directory.appendingPathComponent("settings.png"), width: 620, height: 580)
        var emptyAssistant = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
        emptyAssistant["selected"] = []
        emptyAssistant["master"] = ["id": "master", "name": "Session Bridge coding", "ready": true, "provider": "codex", "executionMode": "desktop"]
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: emptyAssistant))
        try render(BridgePage { MasterSetupView(compact: true) }, model, .dark, directory.appendingPathComponent("assistant-empty.png"), width: 820, height: 340)
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: Data(fixture.utf8))
        try render(BridgePage { MasterSetupView(compact: true) }, model, .dark, directory.appendingPathComponent("assistant-connected.png"), width: 820, height: 390)
        var groupFixture = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
        groupFixture["destination"] = ["kind": "group", "name": "Sidekick", "jid": "sample-group"]
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: groupFixture))
        try render(WhatsAppView(autoDiscoverGroups: false), model, .dark, directory.appendingPathComponent("whatsapp-group.png"), height: 900)
        model.recoveredGroups = []
        try render(WhatsAppView(autoDiscoverGroups: false), model, .dark, directory.appendingPathComponent("whatsapp-group-empty.png"), height: 900)
        groupFixture["voice"] = ["ready": false, "local": true, "bundled": false]
        groupFixture["destination"] = ["kind": "self", "name": "Message yourself"]
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: groupFixture))
        try render(WhatsAppView(autoDiscoverGroups: false), model, .dark, directory.appendingPathComponent("whatsapp-voice-unavailable.png"))
        model.recoveredGroups = [RecoveredGroups.Group(id: "sample-group", name: "Sidekick")]
        var attention = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
        attention["approvals"] = [["code": "sample", "alias": "codex-signin", "question": "Allow the agent to run the project test suite?", "kind": "approval"]]
        attention["jobs"] = [["id": "wa:review", "binding_id": "site", "status": "uncertain", "created_at": 1792873390671, "error": "Delivery could not be confirmed. Check this session before resending."]]
        attention["pendingJobs"] = [
            ["id": "wa:review", "binding_id": "master", "status": "uncertain", "canClose": true, "created_at": 1792873390671, "error": "Bridge restarted during delivery. Check the native session before retrying."],
            ["id": "wa:awaiting", "binding_id": "master", "status": "submitted", "canClose": true, "created_at": 1792873300671, "preview": "The user wrote: Give me an update on the website redesign."]
        ]
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: attention))
        try render(WhatsAppView(autoDiscoverGroups: false), model, .dark, directory.appendingPathComponent("whatsapp-unfinished.png"), height: 1100)
        attention["approvals"] = []
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: attention))
        try render(ActivityView(), model, .dark, directory.appendingPathComponent("activity-recovery.png"), width: 1100, height: 1050)
        model.page = .whatsapp
        try render(ContentView(), model, .dark, directory.appendingPathComponent("recovery-window.png"), width: 1100, height: 780)
        model.page = .whatsapp
        try render(WhatsAppView(autoDiscoverGroups: false), model, .light, directory.appendingPathComponent("whatsapp-attention.png"))
        try render(ActivityView(), model, .light, directory.appendingPathComponent("activity-attention.png"))
        var setup = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
        setup["master"] = NSNull(); setup["selected"] = []
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: setup))
        try render(BridgePage { MasterSetupView(compact: true) }, model, .light, directory.appendingPathComponent("master-setup.png"))
        var coordinatorSetup = setup["masterSetup"] as! [String: Any]
        let sessionRows: [[String: Any]] = [
            ["id": "ready", "name": "Website redesign", "cwd": "/Projects/website", "available": true, "updatedAt": 1792873390671],
            ["id": "saved", "name": "Release planning", "cwd": "/Projects/planning", "available": false, "status": "Open this saved chat in Claude Desktop to connect."],
            ["id": "saved2", "name": "Mobile app", "cwd": "/Projects/mobile", "available": false]
        ]
        coordinatorSetup["platforms"] = ["codex", "claude"].flatMap { provider in
            ["desktop", "cli"].map { mode -> [String: Any] in
                ["provider": provider, "executionMode": mode, "label": provider + " " + mode, "available": true, "sessions": sessionRows]
            }
        }
        coordinatorSetup["attempts"] = [["id": "previous", "status": "set-aside", "provider": "claude", "executionMode": "cli", "nativeId": "earlier-session", "bindingId": "earlier-binding", "error": "Claude authentication expired. Sign in to the native Claude CLI, then recover this exact setup."]]
        setup["masterSetup"] = coordinatorSetup
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: setup))
        try render(BridgePage { MasterSetupView(provider: "claude", mode: "desktop", action: "existing") }, model, .dark, directory.appendingPathComponent("coordinator-existing.png"), width: 720, height: 790)
        try render(BridgePage { MasterSetupView() }, model, .dark, directory.appendingPathComponent("coordinator-new.png"), width: 720, height: 640)
        coordinatorSetup["attempts"] = []
        setup["masterSetup"] = coordinatorSetup
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: setup))
        try render(MasterSetupView(dialogOnly: true), model, .dark, directory.appendingPathComponent("create-dialog-auto.png"), width: 540, height: 490)
        try render(MasterSetupView(dialogOnly: true, name: "My coding assistant"), model, .dark, directory.appendingPathComponent("create-dialog-custom.png"), width: 540, height: 490)
        try render(MasterSetupView(provider: "claude", mode: "desktop", dialogOnly: true), model, .dark, directory.appendingPathComponent("create-dialog-claude.png"), width: 540, height: 600)
        try render(MasterSetupView(provider: "claude", mode: "desktop", action: "existing", dialogOnly: true), model, .dark, directory.appendingPathComponent("existing-dialog.png"), width: 620, height: 690)
        var paused = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
        paused["whatsapp"] = ["status": "paused"]
        paused["preferences"] = ["backgroundEnabled": false, "keepAwake": false, "assertionActive": false]
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: paused))
        try render(WhatsAppView(autoDiscoverGroups: false), model, .light, directory.appendingPathComponent("whatsapp-paused.png"))
        try render(WhatsAppView(autoDiscoverGroups: false), model, .light, directory.appendingPathComponent("whatsapp-paused.png"))
        var recoverySetup = paused["masterSetup"] as! [String: Any]
        recoverySetup["operation"] = ["id": "sample-recovery", "status": "uncertain", "nativeId": "sample-native", "error": "Creation could not be confirmed after reconnecting."]
        paused["masterSetup"] = recoverySetup
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: paused))
        try render(BridgePage { MasterSetupView(compact: true) }, model, .light, directory.appendingPathComponent("master-recovery-paused.png"))
        var trust = try JSONSerialization.jsonObject(with: Data(fixture.utf8)) as! [String: Any]
        var trustSetup = trust["masterSetup"] as! [String: Any]
        trustSetup["operation"] = ["id": "sample-trust", "status": "uncertain", "nativeId": "sample-native", "needsTrust": true, "provider": "claude", "error": "Claude needs you to trust this master folder. Open Claude setup, accept its workspace trust prompt, then return here and retry this setup."]
        trust["masterSetup"] = trustSetup
        model.status = try JSONDecoder().decode(BridgeStatus.self, from: JSONSerialization.data(withJSONObject: trust))
        try render(BridgePage { MasterSetupView(compact: true) }, model, .dark, directory.appendingPathComponent("master-trust.png"), height: 900)
        model.status = nil
        model.reachable = false
        NSApp.appearance = NSAppearance(named: .aqua)
        try render(WhatsAppView(autoDiscoverGroups: false), model, .light, directory.appendingPathComponent("onboarding.png"))
        try render(WhatsAppView(autoDiscoverGroups: false), model, .light, directory.appendingPathComponent("pairing.png"))
    }
    private func render<V: View>(_ view: V, _ model: BridgeModel, _ scheme: ColorScheme, _ url: URL, width: CGFloat = 800, height: CGFloat = 760) throws {
        if let only = ProcessInfo.processInfo.environment["WSB_RENDER_ONLY"], !only.split(separator: ",").contains(Substring(url.lastPathComponent)) { return }
        let content = VStack(spacing: 0) {
            Text("Design preview · sample data").font(.caption).foregroundStyle(.secondary).padding(10)
            view
        }.environmentObject(model).environment(\.colorScheme, scheme).tint(BridgeStyle.action)
            .frame(width: width, height: height).background(BridgeStyle.canvas)
        let host = NSHostingView(rootView: content)
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.appearance = NSAppearance(named: scheme == .light ? .aqua : .darkAqua)
        let window = NSWindow(contentRect: host.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            Issue.record("Could not allocate render surface"); return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            Issue.record("Could not render \(url.lastPathComponent)"); return
        }
        try data.write(to: url)
        window.contentView = nil
    }
}
