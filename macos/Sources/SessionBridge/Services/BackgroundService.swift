import Foundation

enum BackgroundService {
    static func start(installations: [InstalledAgent]) async throws {
        let executables = Dictionary(uniqueKeysWithValues: installations.compactMap { agent in
            agent.cli.map { (agent.id, $0.path) }
        })
        try await Task.detached {
            let fm = FileManager.default
            let home = fm.homeDirectoryForCurrentUser
            let domain = "gui/\(getuid())"
            // An existing personal installation owns its connection. Never boot it out.
            for label in ["com.sagar.whatsapp-session-bridge", "app.sessionbridge.service"] {
                if (try? run("/bin/launchctl", ["print", "\(domain)/\(label)"])) == 0 {
                    guard try run("/bin/launchctl", ["kickstart", "\(domain)/\(label)"]) == 0 else {
                        throw BridgeFailure.message("macOS could not start the registered background service.")
                    }
                    return
                }
            }
            guard let resources = Bundle.main.resourceURL else { throw BridgeFailure.message("App resources are missing.") }
            let node = resources.appendingPathComponent("runtime/node")
            let bridge = resources.appendingPathComponent("bridge")
            guard fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: bridge.appendingPathComponent("dist/main.js").path) else {
                throw BridgeFailure.message("The bundled bridge is missing. Rebuild or reinstall FarFromDesk.")
            }
            let state = home.appendingPathComponent("Library/Application Support/WhatsApp Session Bridge")
            let logs = state.appendingPathComponent("logs")
            try fm.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
            var env = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin", "WSB_STATE_DIR": state.path,
                       "WSB_PORT": "47831", "WSB_DESKTOP_SYNC_BIN": bridge.appendingPathComponent("native/desktop-sync").path]
            if let codex = executables["codex"] { env["WSB_CODEX_BIN"] = codex }
            if let claude = executables["claude"] { env["WSB_CLAUDE_BIN"] = claude }
            let plist: [String: Any] = [
                "Label": "app.sessionbridge.service",
                "ProgramArguments": [node.path, bridge.appendingPathComponent("dist/main.js").path],
                "WorkingDirectory": bridge.path, "EnvironmentVariables": env,
                "RunAtLoad": true, "KeepAlive": true, "ThrottleInterval": 10,
                "StandardOutPath": logs.appendingPathComponent("service.log").path,
                "StandardErrorPath": logs.appendingPathComponent("error.log").path
            ]
            let agents = home.appendingPathComponent("Library/LaunchAgents")
            try fm.createDirectory(at: agents, withIntermediateDirectories: true)
            let file = agents.appendingPathComponent("app.sessionbridge.service.plist")
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: file, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            guard try run("/bin/launchctl", ["bootstrap", domain, file.path]) == 0 else {
                throw BridgeFailure.message("macOS did not allow the background service to start. Check System Settings → General → Login Items & Extensions.")
            }
        }.value
        try await Task.sleep(for: .seconds(2))
    }

    private static func run(_ executable: String, _ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        return process.terminationStatus
    }
}
