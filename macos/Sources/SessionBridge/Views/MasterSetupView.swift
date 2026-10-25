import SwiftUI
import AppKit

struct MasterSetupView: View {
    var compact = false
    var dialogOnly = false
    @EnvironmentObject var bridge: BridgeModel
    @ViewState private var selected = "codex"
    @ViewState private var selectedMode = "cli"
    @ViewState private var desktopParent = ""
    @ViewState private var desktopSearch = ""
    @ViewState private var desktopVisibleCount = 30
    @ViewState private var setupAction = "new"
    @ViewState private var abandonID = ""
    @ViewState private var showUseDesktop = false
    @ViewState private var replacing = false
    @ViewState private var automaticName = true
    @ViewState private var customName = ""
    @ViewState private var showPrompt = false
    @ViewState private var abandonSetup = false
    @ViewState private var confirmBackground = false
    @ViewState private var openingSessionID: String? = nil
    @ViewState private var openStatus: String? = nil
    @ViewState private var openTask: Task<Void, Never>? = nil
    var dialogHeight: CGFloat {
        let content: CGFloat = setupAction == "existing" ? 650 : (needsLauncher ? 560 : 450)
        return min(content + (failures.isEmpty ? 0 : 100), max(420, (NSScreen.main?.visibleFrame.height ?? 900) - 140))
    }
    var automaticSessionName: String { "FarFromDesk · " + platformName }
    var resolvedSessionName: String { automaticName ? automaticSessionName : customName.trimmingCharacters(in: .whitespacesAndNewlines) }
    var validSessionName: Bool { automaticName || (!resolvedSessionName.isEmpty && resolvedSessionName.utf16.count <= 80 && resolvedSessionName.rangeOfCharacter(from: .controlCharacters) == nil) }
    init(compact: Bool = false, provider: String = "codex", mode: String = "cli", action: String = "new", dialogOnly: Bool = false, name: String? = nil) {
        self.compact = compact
        self.dialogOnly = dialogOnly
        _automaticName = ViewState(initialValue: name == nil)
        _customName = ViewState(initialValue: name ?? "")
        _selected = ViewState(initialValue: provider)
        _selectedMode = ViewState(initialValue: mode)
        _setupAction = ViewState(initialValue: action)
    }
    var operation: MasterSetup.Operation? { bridge.status?.masterSetup?.operation }
    var creating: Bool { operation?.status == "creating" }
    var availability: String {
        if !bridge.reachable { return "Bridge offline" }
        if bridge.status?.preferences?.backgroundEnabled != true { return "Background access paused" }
        if !bridge.connected { return "Waiting for WhatsApp connection" }
        return "Ready for your message"
    }
    var configured: Bool { bridge.status?.master?.ready == true }
    var platforms: [MasterSetup.Platform] {
        var seen = Set<String>()
        return (bridge.status?.masterSetup?.platforms ?? []).filter { seen.insert($0.id).inserted }
    }
    var failures: [MasterSetup.Operation] {
        var result = bridge.status?.masterSetup?.attempts ?? []
        if let op = operation, ["uncertain", "set-aside"].contains(op.status) { result.insert(op, at: 0) }
        return result
    }
    var unfinished: [BridgeStatus.Job] {
        let masterID = bridge.status?.master?.id ?? bridge.status?.bindings.first(where: { $0.name == "WhatsApp master" })?.id
        return bridge.status?.unfinishedRequests.filter { $0.binding_id == masterID } ?? []
    }
    var selectedPlatform: MasterSetup.Platform? { platforms.first { $0.provider == selected && ($0.executionMode ?? "cli") == selectedMode } }
    var desktopMatches: [MasterSetup.Platform.DesktopSession] {
        let terms = desktopSearch.lowercased().split(whereSeparator: \.isWhitespace)
        return (selectedPlatform?.sessions ?? []).filter { session in
            terms.allSatisfy { term in (session.name + " " + (session.cwd ?? "") + " " + session.id).lowercased().contains(term) }
        }.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }
    var creationBody: [String: Any] {
        var body: [String: Any] = ["provider": selected, "executionMode": selectedMode, "operationId": UUID().uuidString.lowercased()]
        if !automaticName { body["name"] = resolvedSessionName }
        if selected == "claude" && selectedMode == "desktop" { body["desktopParentId"] = desktopParent }
        return body
    }
    func isSelected(_ platform: MasterSetup.Platform) -> Bool { selected == platform.provider && selectedMode == (platform.executionMode ?? "cli") }
    var needsLauncher: Bool { selected == "claude" && selectedMode == "desktop" && setupAction == "new" }
    var chosenSession: MasterSetup.Platform.DesktopSession? { selectedPlatform?.sessions?.first { $0.id == desktopParent } }
    var canStart: Bool { bridge.reachable && !bridge.busy && !creating && bridge.status?.preferences?.backgroundEnabled == true && selectedPlatform?.available == true }
    var canCreate: Bool { canStart && validSessionName && (!needsLauncher || chosenSession?.available == true) }
    var canSelect: Bool { canStart && chosenSession?.available == true }
    var platformName: String { (selected == "claude" ? "Claude" : "Codex") + (selectedMode == "desktop" ? " Desktop" : " CLI") }
    var body: some View {
        if dialogOnly { setupDialog } else { masterCard }
    }
    var masterBinding: BridgeStatus.Binding? { bridge.status?.bindings.first { $0.id == bridge.status?.master?.id } }
    var assistantReady: Bool { bridge.connected && bridge.status?.preferences?.backgroundEnabled == true }
    var assistantStatus: String {
        if !bridge.reachable { return "Offline" }
        if bridge.status?.preferences?.backgroundEnabled != true { return "Paused" }
        if !bridge.connected { return "Waiting" }
        return masterBinding?.running == true ? "Working" : "Ready"
    }
    var assistantSummary: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 14) {
                ProviderIcon(provider: bridge.status?.master?.provider ?? "codex", size: 48)
                    .background(BridgeStyle.accentWash, in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 5) {
                    Text(bridge.status?.master?.name ?? "Master chat")
                        .font(BridgeTypography.font(size: 18, weight: .semibold)).lineLimit(2).textSelection(.enabled)
                    Text("\(bridge.status?.master?.provider == "claude" ? "Claude" : "Codex") · \(bridge.status?.master?.executionMode == "desktop" ? "Desktop" : "CLI")")
                        .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                StatusLabel(text: assistantStatus, active: assistantReady).help(availability)
                Menu {
                    Button(showPrompt ? "Hide instructions" : "View instructions") { showPrompt.toggle() }
                    if let binding = masterBinding {
                        Divider()
                        Button("Copy session ID") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(binding.native_id, forType: .string)
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold))
                        .frame(width: 30, height: 30).contentShape(Rectangle())
                }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .help("Master chat options").accessibilityLabel("Master chat options")
            }
            HStack(alignment: .center, spacing: 20) {
                Text("Handles your WhatsApp requests and coordinates other sessions.")
                    .font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Change platform or master", systemImage: "arrow.triangle.2.circlepath") {
                    selected = bridge.status?.master?.provider ?? "codex"
                    selectedMode = bridge.status?.master?.executionMode ?? "cli"
                    setupAction = "existing"
                    desktopParent = ""; desktopSearch = ""; desktopVisibleCount = 30
                    replacing = true
                }.buttonStyle(BridgePrimaryButtonStyle()).controlSize(.small)
                    .disabled(creating || bridge.busy)
                    .help("Choose a platform, then select an existing master chat or create a new one")
            }
            if !unfinished.isEmpty {
                Button { bridge.page = .activity } label: {
                    Label("\(unfinished.count) requests need a reply or review", systemImage: "clock")
                        .font(BridgeTypography.caption)
                }.buttonStyle(.link)
            }
        }
    }
    var masterCard: some View {
        BridgeCard {
            if configured {
                assistantSummary
            } else {
                setupForm
                setupActions
            }
            if creating {
                Divider()
                ProgressView("Creating your master chat…")
                Text(configured ? "Your current master remains configured until setup succeeds." : "This may take a moment. The new session receives its coordinator instructions and bridge tools.").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
            if !failures.isEmpty { recovery }
            if showPrompt {
                Divider()
                Text("Coordinator instructions").font(BridgeTypography.font(size: 13, weight: .semibold))
                ScrollView {
                    Text(bridge.status?.masterSetup?.prompt ?? "Start the bridge to load the coordinator instructions.")
                        .font(BridgeTypography.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(height: 210)
            }
        }
        .onDisappear { cancelOpenCheck() }
        .onChange(of: operation?.status) { _, status in if status == "ready" { replacing = false } }
        .sheet(isPresented: $replacing) { setupDialog }
        .confirmationDialog("Use the selected session as your coordinator?", isPresented: $showUseDesktop, titleVisibility: .visible) {
            Button("Use selected session") {
                replacing = false
                Task { await bridge.perform("/api/master-select", body: ["provider": selected, "executionMode": selectedMode, "sessionId": desktopParent, "operationId": UUID().uuidString.lowercased()]) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This existing session will receive your WhatsApp requests and coordinate sessions you identify. Existing conversations and project permissions stay intact. If replacing a coordinator, its unfinished bridge requests close; already-running native work may continue.") }
        .confirmationDialog("Abandon this unconfirmed setup?", isPresented: $abandonSetup, titleVisibility: .visible) {
            Button("Abandon setup", role: .destructive) { Task { await bridge.perform("/api/master-abandon", body: ["operationId": abandonID]) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The previous master stays configured. Any newly created native conversation is preserved, but its bridge access will be disabled. You can then explicitly create a different master.") }
        .confirmationDialog("Allow background operation?", isPresented: $confirmBackground, titleVisibility: .visible) {
            Button("Allow background operation") {
                Task {
                    if !bridge.reachable { await bridge.startService() }
                    if bridge.reachable { await bridge.preferences(background: true, awake: false) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Run the local bridge so WhatsApp can reach your sessions while this window is closed. You can pause this in Settings. Keep-awake remains off.") }
    }
    var setupDialog: some View {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text(setupAction == "new" ? "Create a master chat" : "Choose an existing session").font(BridgeTypography.font(size: 20, weight: .semibold))
                    Spacer()
                    Button { replacing = false } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).padding(5) }.buttonStyle(.plain).help("Close")
                }
                Text(configured ? "Your current master stays active until this one is ready." : "Connect a dedicated assistant to WhatsApp.")
                    .font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary).fixedSize(horizontal: false, vertical: true)
                ScrollView(showsIndicators: false) { VStack(alignment: .leading, spacing: 16) { setupForm; if !failures.isEmpty { recovery } }.frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: .infinity)
                Divider()
                setupActions
            }.padding(24).frame(width: setupAction == "existing" ? 620 : 540, height: dialogHeight).background(BridgeStyle.panel)
                .onDisappear { cancelOpenCheck() }
                .foregroundStyle(BridgeStyle.ink).preferredColorScheme(.dark)
    }
    var setupForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("App").font(BridgeTypography.callout)
                Spacer(minLength: 16)
                BridgeAppPicker(
                    options: platforms.map { .init(id: $0.id, title: ($0.provider == "claude" ? "Claude" : "Codex") + ($0.executionMode == "desktop" ? " Desktop" : " CLI")) },
                    selection: selected + ":" + selectedMode
                ) { id in
                    guard let platform = platforms.first(where: { $0.id == id }) else { return }
                    cancelOpenCheck()
                    selected = platform.provider; selectedMode = platform.executionMode ?? "cli"
                    desktopParent = ""; desktopSearch = ""; desktopVisibleCount = 30
                }.disabled(creating || bridge.busy)
            }
            if selectedPlatform?.discoveryError != nil {
                Text("The app list is updating. Saved sessions will refresh automatically.").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 4) {
                ForEach(["new", "existing"], id: \.self) { action in
                    BridgeTab(title: action == "new" ? "Create new session" : "Use existing session", expands: true, selected: setupAction == action) {
                        setupAction = action
                    }
                }
            }.padding(4).background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 10))
                .disabled(creating || bridge.busy)
            if setupAction == "new" {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Session name").font(BridgeTypography.headline)
                        Spacer()
                        Toggle("Automatic", isOn: $automaticName).toggleStyle(.switch).controlSize(.mini).fixedSize().disabled(creating || bridge.busy)
                    }
                    if automaticName {
                        Text(automaticSessionName).font(BridgeTypography.callout)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            .background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 9))
                    } else {
                        TextField("e.g. My coding assistant", text: $customName).disabled(creating || bridge.busy)
                            .textFieldStyle(.plain).padding(12)
                            .background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 9))
                            .overlay(RoundedRectangle(cornerRadius: 9).stroke(validSessionName ? BridgeStyle.border : Color.orange))
                        if !validSessionName { Text("Enter a name using 1–80 characters.").font(BridgeTypography.caption).foregroundStyle(Color.orange) }
                    }
                }
                if needsLauncher {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Launch from Claude").font(BridgeTypography.headline)
                        Menu {
                            ForEach((selectedPlatform?.sessions ?? []).filter(\.available)) { session in
                                Button(session.name) { desktopParent = session.id }
                            }
                        } label: {
                            Text(chosenSession?.name ?? "Choose an open Claude chat…").lineLimit(1)
                        }.menuStyle(.borderlessButton).fixedSize(horizontal: false, vertical: true)
                            .padding(12).background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 9))
                        Text("Claude uses this chat to create a separate master. Its native permissions still apply.")
                            .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    }
                }
            }
            if setupAction == "existing" {
                TextField("Search sessions by name or project", text: $desktopSearch)
                    .textFieldStyle(.plain).padding(.horizontal, 12).padding(.vertical, 11)
                    .background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(BridgeStyle.border)).onChange(of: desktopSearch) { _, _ in desktopVisibleCount = 30 }
                HStack {
                    Text(selected == "codex" ? "\(desktopMatches.count) saved chats" : "\(desktopMatches.count) saved · \(selectedPlatform?.sessions?.filter(\.available).count ?? 0) live connections")
                    Spacer()
                    Text("Latest activity first")
                }.font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(Array(desktopMatches.prefix(desktopVisibleCount))) { session in
                            Button { cancelOpenCheck(); desktopParent = session.id } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: desktopParent == session.id ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(desktopParent == session.id ? BridgeStyle.success : BridgeStyle.secondary)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(session.name).font(BridgeTypography.font(size: 13, weight: .medium)).foregroundStyle(BridgeStyle.ink).lineLimit(1)
                                        Text(session.cwd ?? "Project unavailable").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary).lineLimit(1)
                                    }
                                    Spacer()
                                    Text(selected == "codex" ? (selectedMode == "desktop" ? "Can queue" : "Can resume") : (session.available ? "Live connection" : (selectedMode == "desktop" ? "Open in Claude" : "Saved chat")))
                                        .font(BridgeTypography.caption).foregroundStyle(session.available ? BridgeStyle.success : BridgeStyle.secondary)
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(desktopParent == session.id ? BridgeStyle.success : BridgeStyle.border))
                            }.buttonStyle(.plain).disabled(creating || bridge.busy)
                        }
                        if desktopMatches.count > desktopVisibleCount { Button("Show 30 more") { desktopVisibleCount += 30 } }
                        if desktopMatches.isEmpty { Text("No matching sessions. Refresh or try another name.").font(BridgeTypography.callout).foregroundStyle(BridgeStyle.secondary) }
                    }
                }.frame(height: 220)
                if let session = chosenSession, !session.available {
                    Label("This chat is saved. FarFromDesk has not confirmed a live connection yet.", systemImage: "info.circle")
                        .font(BridgeTypography.caption).foregroundStyle(Color.orange)
                    if selected == "claude" && selectedMode == "desktop", ClaudeDesktopLink.resume(session.desktopId) != nil {
                        HStack(spacing: 12) {
                            Button(openingSessionID == session.id ? "Checking connection…" : "Open in Claude") { openSavedClaude(session) }
                                .disabled(openingSessionID != nil || creating || bridge.busy)
                            if openingSessionID != nil { ProgressView().controlSize(.small) }
                        }
                        Text(openStatus ?? "Open this exact saved chat in Claude. FarFromDesk checks its connection before enabling it. Claude may ask you to sign in or approve project access.")
                            .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    } else {
                        Text("Open this chat in its original app/account or CLI, then refresh. Archived chats and unavailable accounts may need attention there first.")
                            .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    }
                } else if desktopParent.isEmpty {
                    Text(needsLauncher ? "Select a connectable launcher to create your new Claude master." : "Select a session to use as your master.")
                        .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                }
                Text(selected == "codex" ? "Saved Codex chats can receive requests. This does not verify account limits or successful execution." : "A saved chat can open in Claude without a live bridge connection. Open it to connect; account limits and native permissions still apply.")
                    .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
            if creating { ProgressView("Creating your master chat…").font(BridgeTypography.callout) }
            if selectedPlatform?.available != true {
                Text(selectedPlatform?.reason ?? "Start the bridge and refresh to discover apps.").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
            }
            if !bridge.reachable || bridge.status?.preferences?.backgroundEnabled != true {
                Button(!bridge.reachable ? "Start bridge" : "Allow background access") { confirmBackground = true }.disabled(bridge.busy)
            }
        }
    }
    var setupActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                if replacing || dialogOnly { Button("Cancel") { replacing = false } }
                Spacer()
                if setupAction == "existing" {
                    Button(configured ? "Use as master" : "Use selected session") { showUseDesktop = true }
                        .buttonStyle(BridgePrimaryButtonStyle()).disabled(!canSelect)
                } else {
                    Button(configured ? "Create replacement" : "Create master") {
                        let body = creationBody
                        Task { await bridge.perform("/api/master-create", body: body) }
                    }
                        .buttonStyle(BridgePrimaryButtonStyle()).disabled(!canCreate)
                }
            }
            Text(configured ? "Switches only after setup succeeds. Previous master requests will then close." : "Your chosen app’s sign-in and permissions apply.")
                .font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
        }
    }
    func cancelOpenCheck() {
        openTask?.cancel(); openTask = nil; openingSessionID = nil; openStatus = nil
    }
    func openSavedClaude(_ session: MasterSetup.Platform.DesktopSession) {
        guard let url = ClaudeDesktopLink.resume(session.desktopId) else { return }
        cancelOpenCheck()
        guard NSWorkspace.shared.open(url) else { openStatus = "macOS could not open Claude. Check that the app is installed."; return }
        openingSessionID = session.id
        openStatus = "Opening the saved chat. Checking for its local connection…"
        openTask = Task { @MainActor in
            defer { if !Task.isCancelled { openingSessionID = nil } }
            do {
                for _ in 0..<3 {
                    try await Task.sleep(for: .seconds(3))
                    let data = try await bridge.client.request("/api/master-options?fresh=1")
                    try Task.checkCancellation()
                    let setup = try JSONDecoder().decode(MasterSetup.self, from: data)
                    await bridge.refresh()
                    try Task.checkCancellation()
                    if setup.platforms.first(where: { $0.provider == "claude" && $0.executionMode == "desktop" })?.sessions?.contains(where: { $0.id == session.id && $0.available }) == true {
                        openStatus = "Connected. You can now use this session."; return
                    }
                }
                openStatus = "Claude opened, but this chat is not reachable yet. Check its sign-in, project permissions or startup state. The list refreshes automatically; your current master is unchanged."
            } catch is CancellationError { }
            catch { if !Task.isCancelled { openStatus = "The connection check failed. Check Claude; the list refreshes automatically." } }
        }
    }
    func openClaudeTrust(_ op: MasterSetup.Operation) {
        guard let path = op.cwd, let cli = bridge.installations.first(where: { $0.id == "claude" })?.cli else {
            bridge.error = "Claude CLI or its setup folder is unavailable."; return
        }
        let folder = URL(fileURLWithPath: path).standardizedFileURL
        let parent = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/WhatsApp Session Bridge/masters").standardizedFileURL
        guard folder.deletingLastPathComponent() == parent,
              UUID(uuidString: folder.lastPathComponent) != nil,
              folder.resolvingSymlinksInPath() == folder else {
            bridge.error = "The master setup folder could not be verified."; return
        }
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let script = folder.appendingPathComponent("open-claude-trust.command")
        do {
            let text = "#!/bin/zsh\ncd -- " + quote(folder.path) + " || exit 1\nexec " + quote(cli.path) + "\n"
            try text.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            NSWorkspace.shared.open(script)
        } catch { bridge.error = "Could not open Claude setup: " + error.localizedDescription }
    }
    var recovery: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(failures, id: \.id) { attempt in
                VStack(alignment: .leading, spacing: 10) {
                    Label("Earlier setup · " + (attempt.provider == "claude" ? "Claude" : "Codex") + " · " + (attempt.executionMode == "desktop" ? "Desktop" : "CLI"), systemImage: "exclamationmark.circle")
                        .font(BridgeTypography.headline).foregroundStyle(Color.orange)
                    Text(attempt.error ?? "Creation could not be confirmed.").font(BridgeTypography.callout).textSelection(.enabled)
                    Text("You can create a replacement now. Recover only if you want to use this earlier session.").font(BridgeTypography.caption).foregroundStyle(BridgeStyle.secondary)
                    HStack {
                        if attempt.needsTrust == true { Button("Open Claude setup") { openClaudeTrust(attempt) } }
                        if attempt.bindingId != nil && (attempt.nativeId != nil || attempt.executionMode == "desktop") {
                            Button("Recover this session") { Task { await bridge.perform("/api/master-recover", body: ["operationId": attempt.id]) } }
                                .disabled(bridge.status?.preferences?.backgroundEnabled != true)
                        }
                        Button("Abandon session…", role: .destructive) { abandonID = attempt.id; abandonSetup = true }
                    }.disabled(!bridge.reachable || bridge.busy || creating)
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(BridgeStyle.canvas, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}
