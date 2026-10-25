import SwiftUI

struct DestinationView: View {
    @EnvironmentObject var bridge: BridgeModel
    var autoDiscover = true
    @ViewState private var groupName = "FarFromDesk"
    @ViewState private var confirmGroup = false
    @ViewState private var showGroupForm = false
    @ViewState private var groupMode: Bool? = nil
    var showingGroups: Bool { groupMode ?? isGroup }
    var isGroup: Bool { bridge.status?.destination?.kind == "group" }
    var body: some View {
        BridgeCard {
            SectionHeading(title: "Where should replies appear?", detail: "Current: \(bridge.status?.destination?.name ?? "Message yourself")")
            HStack(alignment: .top, spacing: 14) {
                destinationChoice("Message yourself", "Use your existing personal chat.", "person.crop.circle", selected: !showingGroups) {
                    groupMode = false
                    showGroupForm = false
                    Task {
                        await bridge.perform("/api/destination", body: [:])
                        if bridge.error != nil { groupMode = nil }
                    }
                }
                destinationChoice("Private group", "Choose a group or set one up.", "person.2", selected: showingGroups) {
                    groupMode = true
                }
            }
            if showingGroups {
                Divider()
                if !isGroup {
                    Text("Choose a group below to switch replies. For now, replies still go to Message yourself.")
                        .font(BridgeTypography.callout).foregroundStyle(BridgeStyle.ink)
                }
                HStack(alignment: .center, spacing: 12) {
                    Text("Your bridge groups").font(BridgeTypography.font(size: 13, weight: .semibold))
                    Spacer(minLength: 12)
                    Button("Refresh groups", systemImage: "arrow.clockwise") {
                        Task { await bridge.recoverGroups(forceRefresh: true) }
                    }
                    .disabled(!bridge.connected || bridge.busy || bridge.loadingGroups)
                }
                if bridge.loadingGroups {
                    ProgressView("Finding your existing bridge group…").font(BridgeTypography.callout)
                } else if let error = bridge.groupDiscoveryError {
                    Text("Could not check your existing groups. \(error)").font(BridgeTypography.callout).foregroundStyle(.orange)
                    Button("Try again") { Task { await bridge.recoverGroups(forceRefresh: true) } }.disabled(!bridge.connected)
                }
                if !bridge.recoveredGroups.isEmpty {
                    ForEach(bridge.recoveredGroups) { group in
                        HStack(spacing: 12) {
                            Image(systemName: "person.2.fill").foregroundStyle(BridgeStyle.accent)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(group.name).font(BridgeTypography.font(size: 13, weight: .semibold))
                                Text("Saved group · membership checked when used").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                            }
                            Spacer()
                            if bridge.status?.destination?.jid == group.id {
                                StatusLabel(text: "In use")
                            } else {
                                Button("Use this group") {
                                    Task { await bridge.perform("/api/destination", body: ["jid": group.id]) }
                                }.buttonStyle(BridgePrimaryButtonStyle()).disabled(!bridge.connected || bridge.busy)
                            }
                        }
                    }
                } else if bridge.groupsDiscovered && bridge.groupDiscoveryError == nil && !bridge.loadingGroups {
                    Text("No existing owner-only bridge group was found.").font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary)
                    if !showGroupForm {
                        Button("Set up a private group…") { showGroupForm = true }.disabled(!bridge.connected || bridge.busy)
                    }
                }
                if showGroupForm && bridge.groupsDiscovered && bridge.recoveredGroups.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        TextField("Group name", text: $groupName).textFieldStyle(.roundedBorder)
                        Button("Create group…") { confirmGroup = true }
                            .buttonStyle(BridgePrimaryButtonStyle()).disabled(!bridge.connected || bridge.busy || bridge.loadingGroups || groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Button("Cancel") { showGroupForm = false }
                    }
                    Text("No one else is invited. An existing bridge group is reused if available.").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                }
                Text("Switching chats keeps your master and selected sessions. Pending replies retain their original destination. Group forwarding pauses if another participant is detected.").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
        }
        .task(id: showingGroups && bridge.connected) {
            if autoDiscover && showingGroups && bridge.connected { await bridge.recoverGroups() }
        }
        .onChange(of: bridge.status?.destination?.kind) { _, _ in groupMode = nil }
        .confirmationDialog("Create a WhatsApp group?", isPresented: $confirmGroup, titleVisibility: .visible) {
            Button("Create and use group") {
                Task {
                    await bridge.perform("/api/group-create", body: ["name": groupName, "operationId": UUID().uuidString.lowercased()])
                    if bridge.error == nil { showGroupForm = false; await bridge.recoverGroups(forceRefresh: true) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Create “\(groupName)” for your account only. The bridge switches to it after checking membership. If a bridge group already exists, it is reused.") }
    }
    func destinationChoice(_ title: String, _ detail: String, _ icon: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: icon).font(BridgeTypography.font(size: 22)).foregroundStyle(selected ? BridgeStyle.actionInk : BridgeStyle.secondary)
                    Spacer()
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? BridgeStyle.actionInk : BridgeStyle.border)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(BridgeTypography.font(size: 13, weight: .semibold)).foregroundStyle(selected ? BridgeStyle.actionInk : BridgeStyle.ink)
                    Text(detail).font(BridgeTypography.caption).foregroundStyle(selected ? BridgeStyle.actionInk : BridgeStyle.secondary)
                }
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? BridgeStyle.selection : BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? BridgeStyle.selection : BridgeStyle.border, lineWidth: selected ? 1.5 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).disabled(!bridge.connected || bridge.busy)
            .accessibilityLabel(title + (selected ? ", selected option" : ""))
    }
}
