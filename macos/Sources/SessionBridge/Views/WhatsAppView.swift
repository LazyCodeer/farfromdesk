import SwiftUI
import AppKit

struct WhatsAppView: View {
    var autoDiscoverGroups = true
    @EnvironmentObject var bridge: BridgeModel
    @ViewState private var confirmBackground = false
    @ViewState private var confirmLogout = false
    var qrImage: NSImage? {
        guard let uri = bridge.status?.whatsapp.qr, uri.hasPrefix("data:image/png;base64,"),
              let data = Data(base64Encoded: String(uri.dropFirst("data:image/png;base64,".count))) else { return nil }
        return NSImage(data: data)
    }
    var body: some View {
        BridgePage {
            HStack(alignment: .top, spacing: 18) {
                PageHeading(eyebrow: "", title: "Home", subtitle: "Your WhatsApp connection and coding assistant.")
                Spacer(minLength: 0)
                if bridge.connected {
                    Button("Refresh connection") { Task { await bridge.refresh() } }.disabled(bridge.busy)
                } else {
                    Button(qrImage == nil ? "Connect WhatsApp" : "Check connection", action: connect)
                        .buttonStyle(BridgePrimaryButtonStyle()).controlSize(.large).disabled(bridge.busy)
                }
            }
            if bridge.connected {
                BridgeCard {
                    HStack(spacing: 14) {
                        Image(systemName: "checkmark.message").font(BridgeTypography.font(size: 26)).foregroundStyle(BridgeStyle.success)
                            .frame(width: 48, height: 48)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(bridge.status?.whatsapp.phoneNumber ?? "Your WhatsApp account").font(BridgeTypography.headline)
                            Text("Linked WhatsApp account · Only this account can control Sidekick.").font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary)
                        }
                        Spacer()
                        StatusLabel(text: "Connected")
                        Button("Log out…", role: .destructive) { confirmLogout = true }
                            .disabled(!bridge.reachable || bridge.busy)
                    }
                }
            } else {
                pairing
            }
            if bridge.connected { DestinationView(autoDiscover: autoDiscoverGroups) }
            MasterSetupView(compact: true)
            if let error = bridge.status?.whatsapp.error {
                Label(error, systemImage: "exclamationmark.circle").font(BridgeTypography.callout).foregroundStyle(.orange).textSelection(.enabled)
            }
            if let voice = bridge.status?.voice {
                HStack(spacing: 14) {
                    Image(systemName: voice.ready ? "waveform" : "mic.slash")
                        .font(.system(size: 23, weight: .medium))
                        .foregroundStyle(voice.ready ? BridgeStyle.success : BridgeStyle.warning)
                        .frame(width: 32)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(voice.ready ? "Voice notes ready" : "Voice notes unavailable")
                            .font(BridgeTypography.font(size: 14, weight: .semibold)).foregroundStyle(BridgeStyle.ink)
                        Text(voice.ready ? "Send a voice note in your connected chat. Audio is processed locally on this Mac." : "Reinstall the app or configure local speech tools to enable voice notes.")
                            .font(BridgeTypography.font(size: 12)).foregroundStyle(BridgeStyle.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }.padding(18)
                    .background(BridgeStyle.panel, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder((voice.ready ? BridgeStyle.success : BridgeStyle.warning).opacity(0.35), lineWidth: 1))
            }
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "lock.shield").font(.system(size: 17)).foregroundStyle(BridgeStyle.accent)
                Text("Pause forwarding in Settings, or use Log out above to unlink this device.")
                    .font(BridgeTypography.font(size: 12)).foregroundStyle(BridgeStyle.ink)
                    .lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            }.padding(.horizontal, 4).padding(.vertical, 8)

        }
        .confirmationDialog("Log out of WhatsApp?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Log out", role: .destructive) { Task { await bridge.perform("/api/logout", body: ["confirmed": true]) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Unlink this device and pause forwarding and keep-awake. Your master, selected sessions and request history are kept. Scan a new QR with the same WhatsApp account to reconnect. Work already running in native apps may continue.")
        }
        .confirmationDialog("Allow background access and connect WhatsApp?", isPresented: $confirmBackground, titleVisibility: .visible) {
            Button("Allow and connect") {
                Task {
                    if !bridge.reachable { await bridge.startService() }
                    guard bridge.reachable else { return }
                    await bridge.preferences(background: true, awake: false)
                    if bridge.status?.preferences?.backgroundEnabled == true {
                        await bridge.perform("/api/connect", body: [:])
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The bridge will run on this Mac so WhatsApp can reach your sessions while this window is closed. You can pause it in Settings. Keeping your Mac awake is optional and remains off.") }
    }
    func connect() {
        if !bridge.reachable || bridge.status?.preferences?.backgroundEnabled != true { confirmBackground = true }
        else if qrImage != nil { Task { await bridge.refresh() } }
        else { Task { await bridge.perform("/api/connect", body: [:]) } }
    }
    var pairing: some View {
        BridgeCard {
            SectionHeading(title: "Pair your phone", detail: bridge.reachable ? "A one-time setup" : "Bridge not running")
            HStack(alignment: .center, spacing: 30) {
                Group {
                    if let qrImage {
                        Image(nsImage: qrImage).interpolation(.none).resizable().frame(width: 216, height: 216)
                            .padding(12).background(.white, in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityLabel("WhatsApp pairing QR code. Scan it using Linked devices on your phone.")
                    } else {
                        VStack(spacing: 14) {
                            Image(systemName: "qrcode").font(BridgeTypography.font(size: 52, weight: .regular)).foregroundStyle(BridgeStyle.accent)
                            if bridge.status?.whatsapp.status == "connecting" { ProgressView().controlSize(.small) }
                            Text(bridge.status?.whatsapp.status == "connecting" ? "Preparing your connection…" : "Connect to generate your QR code").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary).multilineTextAlignment(.center)
                        }.frame(width: 240, height: 240).background(BridgeStyle.accentWash, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                VStack(alignment: .leading, spacing: 22) {
                    step("1", "Open WhatsApp", "Use the account you want to connect.")
                    step("2", "Open Linked devices", "Find it in WhatsApp Settings.")
                    step("3", "Link a device", "Scan the QR code shown here.")
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if !bridge.reachable || bridge.status?.preferences?.backgroundEnabled != true {
                Label("Connecting will ask for background access first. No system sleep settings will change.", systemImage: "info.circle")
                    .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
        }
    }
    func step(_ number: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text(number).font(BridgeTypography.font(size: 11, weight: .semibold)).foregroundStyle(BridgeStyle.accent)
                .frame(width: 25, height: 25).background(BridgeStyle.accentWash, in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(BridgeTypography.font(size: 13, weight: .semibold))
                Text(detail).font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
        }
    }
}
