import Foundation

struct InstalledAgent: Identifiable {
    let id: String
    let name: String
    let app: URL?
    let cli: URL?
    var available: Bool { app != nil || cli != nil }
    var installationLabel: String {
        switch (app != nil, cli != nil) {
        case (true, true): "Desktop app and CLI found"
        case (true, false): "Desktop app found · CLI transport unavailable"
        case (false, true): "CLI found"
        default: "Not installed"
        }
    }
}

enum AgentDiscovery {
    static func discover(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [InstalledAgent] {
        let fm = FileManager.default
        let directories = [home.appendingPathComponent(".local/bin"), URL(fileURLWithPath: "/opt/homebrew/bin"),
                           URL(fileURLWithPath: "/usr/local/bin")]
        let nvm = home.appendingPathComponent(".nvm/versions/node")
        let versions = ((try? fm.contentsOfDirectory(at: nvm, includingPropertiesForKeys: nil)) ?? [])
            .sorted { $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending }
        let all = directories + versions.map { $0.appendingPathComponent("bin") }
        func app(_ name: String) -> URL? {
            [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications")]
                .map { $0.appendingPathComponent(name + ".app") }.first { fm.fileExists(atPath: $0.path) }
        }
        func binary(_ name: String, extras: [URL] = []) -> URL? {
            (all.map { $0.appendingPathComponent(name) } + extras).first { fm.isExecutableFile(atPath: $0.path) }
        }
        let codexApp = app("Codex") ?? app("ChatGPT")
        let codexExtras = codexApp.map { [$0.appendingPathComponent("Contents/Resources/codex"),
                                       $0.appendingPathComponent("Contents/Resources/codex-cli/codex")] } ?? []
        return [InstalledAgent(id: "codex", name: "Codex", app: codexApp, cli: binary("codex", extras: codexExtras)),
                InstalledAgent(id: "claude", name: "Claude Code", app: app("Claude"), cli: binary("claude"))]
    }
}
