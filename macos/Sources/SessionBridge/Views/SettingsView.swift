import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @EnvironmentObject var bridge: BridgeModel
    @ViewState private var loginEnabled = SMAppService.mainApp.status == .enabled
    @ViewState private var loginError: String?
    @ViewState private var confirmAwake = false
    @ViewState private var confirmBackground = false
    @ViewState private var confirmCleanup = false
    private var cleanupEnabled: Bool { bridge.status?.requestCleanup?.enabled == true }
    private var cleanupHours: Int { bridge.status?.requestCleanup?.afterHours ?? 24 }
    private var backgroundEnabled: Bool { bridge.status?.preferences?.backgroundEnabled == true }
    var body: some View {
        BridgePage {
            PageHeading(eyebrow: "", title: "Settings", subtitle: "Decide when Sidekick runs and how this Mac stays available.")
            BridgeCard {
                HStack {
                    SectionHeading(title: "On this Mac")
                    StatusLabel(text: bridge.reachable ? "Bridge running" : "Bridge offline", active: bridge.reachable)
                }
                settingRow("app.badge", "Run in the background", "Receive WhatsApp tasks while the window is closed. Turning this off disconnects WhatsApp and pauses forwarding.") {
                    Toggle("Run in the background", isOn: Binding(get: { backgroundEnabled }, set: { enabled in
                        if enabled { confirmBackground = true }
                        else { Task { await bridge.preferences(background: false, awake: false) } }
                    })).labelsHidden().toggleStyle(.switch).disabled(!bridge.reachable || bridge.busy)
                }
                if !bridge.reachable {
                    Button("Start bridge", systemImage: "play") { Task { await bridge.startService() } }.disabled(bridge.busy)
                }
                Divider()
                settingRow("power", "Open at login", "Launch Sidekick when you sign in to this Mac.") {
                    Toggle("Open Sidekick at login", isOn: Binding(get: { loginEnabled }, set: { enabled in
                        do {
                            if enabled { try SMAppService.mainApp.register() }
                            else { try SMAppService.mainApp.unregister() }
                            loginError = nil
                        } catch { loginError = error.localizedDescription }
                        loginEnabled = SMAppService.mainApp.status == .enabled
                    })).labelsHidden().toggleStyle(.switch)
                }
                HStack {
                    if let loginError {
                        Text(loginError).font(BridgeTypography.caption).foregroundStyle(BridgeStyle.warning).textSelection(.enabled)
                    }
                    Spacer()
                    Button("Login Items settings", systemImage: "arrow.up.right") { SMAppService.openSystemSettingsLoginItems() }
                        .buttonStyle(.link).font(BridgeTypography.caption)
                }
                Divider()
                settingRow("moon.zzz", "Keep awake while locked", "Keep work running with the lid open, even when the screen is locked or off. Your password and lock screen stay enabled.") {
                    Toggle("Keep awake while locked", isOn: Binding(get: { bridge.status?.preferences?.keepAwake ?? false }, set: { enabled in
                        if enabled { confirmAwake = true }
                        else { Task { await bridge.preferences(background: true, awake: false) } }
                    })).labelsHidden().toggleStyle(.switch).disabled(!bridge.reachable || !backgroundEnabled || bridge.busy)
                }
                if !backgroundEnabled {
                    Label("Enable background access to use sleep prevention.", systemImage: "info.circle")
                        .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                }
                if bridge.status?.preferences?.assertionActive == true { StatusLabel(text: "Keep-awake active · screen may lock") }
                if let error = bridge.status?.preferences?.error {
                    Text(error).font(BridgeTypography.caption).foregroundStyle(BridgeStyle.warning).textSelection(.enabled)
                }
            }
            BridgeCard {
                SectionHeading(title: "Coding apps")
                ForEach(Array(bridge.installations.enumerated()), id: \.element.id) { index, installed in
                    if index > 0 { Divider() }
                    settingRow(installed.id == "codex" ? "terminal" : "asterisk", installed.name, installed.installationLabel) {
                        Toggle("Enable \(installed.name)", isOn: Binding(
                            get: { bridge.status?.apps.first(where: { $0.provider == installed.id })?.enabled == true },
                            set: { _ in Task { await bridge.toggle(installed.id) } }
                        )).labelsHidden().toggleStyle(.switch).disabled(!bridge.reachable || bridge.busy || !installed.available)
                    }
                }
            }
            BridgeCard {
                SectionHeading(title: "Request cleanup")
                settingRow("clock.badge.checkmark", "Auto-close stale requests", "Close tracking after no recorded updates for the chosen period. Keeps history; never stops native work or marks a task successful.") {
                    Toggle("Auto-close stale requests", isOn: Binding(get: { cleanupEnabled }, set: { enabled in
                        if enabled { confirmCleanup = true }
                        else { Task { await bridge.perform("/api/request-cleanup", body: ["enabled": false, "afterHours": cleanupHours]) } }
                    })).labelsHidden().toggleStyle(.switch).disabled(!bridge.reachable || bridge.busy || bridge.status?.requestCleanup == nil)
                }
                HStack {
                    Text("Close after no updates for").font(BridgeTypography.callout)
                    Spacer()
                    Picker("Inactivity period", selection: Binding(get: { cleanupHours }, set: { hours in
                        Task { await bridge.perform("/api/request-cleanup", body: ["enabled": cleanupEnabled, "afterHours": hours]) }
                    })) {
                        Text("24 hours").tag(24)
                        Text("3 days").tag(72)
                        Text("7 days").tag(168)
                    }.labelsHidden().frame(width: 140).disabled(!bridge.reachable || bridge.busy || bridge.status?.requestCleanup == nil)
                }
                Text("Queued requests, known active deliveries, pending bridge permissions and unfinished delegated work are excluded. A submitted session may still be working without sending updates; auto-close only ends tracking. Late replies are still accepted.")
                    .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Review or bulk-close in Activity") { bridge.page = .activity }.buttonStyle(.link)
            }
            BridgeCard {
                SectionHeading(title: "Access & availability")
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Apple’s supported setup: connect power, an external display, and an external keyboard and mouse. Allow the accessories in macOS, then close the lid.")
                        Link("Apple’s closed-lid requirements", destination: URL(string: "https://support.apple.com/102501")!)
                        Text("Without an external display, Amphetamine offers a separate closed-display mode. It is third-party software and has not been verified on this Mac’s macOS version. Sidekick does not install or enable it.")
                        Link("Amphetamine on the Mac App Store", destination: URL(string: "https://apps.apple.com/app/amphetamine/id937984704")!)
                        Text("Keep an operating laptop ventilated, never in a bag. Sleep prevention does not override manual sleep or low-battery protection. If this Mac sleeps or loses internet, WhatsApp cannot wake or reach it.")
                    }.font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary).padding(.top, 12)
                } label: { disclosureLabel("laptopcomputer", "Lid closed · external display required", "Keep-awake cannot override lid-close sleep") }
                Divider()
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Only your linked WhatsApp account can control the bridge. Use Message yourself or a group containing only you. Revoke access in WhatsApp → Linked devices.")
                        Text("Your master coordinates only selected sessions, gives concise updates and explains blockers. Worker reports do not grant new permissions. Native agent approval rules still apply; the master cannot approve its own actions.")
                        Text("Pausing the bridge does not stop work already running in an agent. Agents with full access can access your account’s files; Sidekick does not sandbox them.")
                        Text("The app connects to the bridge on this Mac. Your local admin credential is never sent to a model.")
                    }.font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary).padding(.top, 12)
                } label: { disclosureLabel("lock.shield", "Privacy & agent permissions", "Your account, selected sessions and native approvals") }
            }
            HStack(spacing: 14) {
                SidekickMark().frame(width: 28, height: 28).foregroundStyle(BridgeStyle.accent)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Sidekick").font(BridgeTypography.font(size: 14, weight: .semibold))
                    Text("Version \(BridgeStyle.version) · Local preview").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                }
                Spacer(minLength: 20)
                Text("This Mac and your agent provider must be online.\nQueued replies are retained during outages.")
                    .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    .multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true)
            }.padding(.horizontal, 8).padding(.vertical, 8)
        }
        .confirmationDialog("Allow the bridge to run in the background?", isPresented: $confirmBackground, titleVisibility: .visible) {
            Button("Allow background operation") { Task { await bridge.preferences(background: true, awake: false) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Your linked WhatsApp can send tasks while this app is closed. You can turn this off at any time. Keep-awake is a separate choice.") }
        .confirmationDialog("Keep this Mac awake while locked?", isPresented: $confirmAwake, titleVisibility: .visible) {
            Button("Keep Mac awake") { Task { await bridge.preferences(background: true, awake: true) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Keep the system awake with the lid open while allowing the screen to lock and turn off. This uses battery and does not bypass your password, native approvals, manual sleep or lid-close sleep. Turn it off to restore normal idle sleep.") }
        .confirmationDialog("Enable automatic request cleanup?", isPresented: $confirmCleanup, titleVisibility: .visible) {
            Button("Enable auto-close") { Task { await bridge.perform("/api/request-cleanup", body: ["enabled": true, "afterHours": cleanupHours]) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Eligible requests with no recorded updates for \(cleanupHours) hours will be marked Auto-closed, including existing old requests. Checks run every minute while background operation is enabled. History is kept and native work continues. You can turn this off at any time.")
        }
    }
    private func settingRow<Control: View>(_ icon: String, _ title: String, _ detail: String, @ViewBuilder control: () -> Control) -> some View {
        HStack(alignment: .center, spacing: 16) {
            Image(systemName: icon).font(.system(size: 19)).foregroundStyle(BridgeStyle.accent).frame(width: 28)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(BridgeTypography.font(size: 14, weight: .medium))
                Text(detail).font(BridgeTypography.font(size: 12)).foregroundStyle(BridgeStyle.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineSpacing(2)
            }.frame(maxWidth: .infinity, alignment: .leading)
            control().padding(.leading, 16)
        }.padding(.vertical, 4)
    }
    private func disclosureLabel(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 18)).foregroundStyle(BridgeStyle.accent).frame(width: 28)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(BridgeTypography.font(size: 13, weight: .medium))
                Text(detail).font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
        }.padding(.vertical, 4)
    }
}
