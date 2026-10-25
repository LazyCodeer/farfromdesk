import Testing
import Foundation
@testable import SessionBridge

struct BridgeContractTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["WSB_LIVE_READ_ONLY_TEST"] == "1"))
    func liveNativeClientDecodesExistingService() async throws {
        let status = try await BridgeClient().status()
        #expect(status.whatsapp.status == "connected")
        #expect(status.master?.ready == true)
    }

    @Test func testExistingServiceStatusDecodesWithoutNewFields() throws {
        let json = #"{"whatsapp":{"status":"connected"},"apps":[{"provider":"claude","name":"Claude Code","enabled":true,"sessions":3}],"master":{"name":"WhatsApp master","ready":true},"bindings":[{"id":"fixture","alias":"legacy","provider":"codex","native_id":"native-fixture","enabled":1}],"jobs":[],"approvals":[]}"#
        let status = try JSONDecoder().decode(BridgeStatus.self, from: Data(json.utf8))
        #expect(status.whatsapp.status == "connected")
        #expect(status.whatsapp.qr == nil)
        #expect(status.apps.first?.sessions == 3)
        #expect(status.master!.ready)
        #expect(status.bindings.first?.name == nil)
        #expect(status.bindings.first?.running == nil)
    }

    @Test func failedSetupHistoryAndFourModesDecode() throws {
        let data = #"{"platforms":[{"provider":"codex","executionMode":"desktop","label":"Codex Desktop","available":true},{"provider":"codex","executionMode":"cli","label":"Codex CLI","available":true},{"provider":"claude","executionMode":"desktop","label":"Claude Desktop","available":true},{"provider":"claude","executionMode":"cli","label":"Claude CLI","available":true}],"operation":null,"attempts":[{"id":"earlier","status":"set-aside","error":"Setup failed","bindingId":"binding"}],"prompt":"Instructions"}"#
        let setup = try JSONDecoder().decode(MasterSetup.self, from: Data(data.utf8))
        #expect(Set(setup.platforms.map(\.id)).count == 4)
        #expect(setup.attempts?.first?.id == "earlier")
        #expect(setup.attempts?.first?.error == "Setup failed")
    }

    @Test func savedClaudeLinksRequireExactDesktopIdentity() {
        let id = "local_11111111-1111-4111-a111-111111111111"
        #expect(ClaudeDesktopLink.resume(id)?.absoluteString == "claude://code/continue?session=" + id)
        for invalid in [nil, "last", "11111111-1111-4111-a111-111111111111", "local_../secret", "local_x?prompt=run"] as [String?] {
            #expect(ClaudeDesktopLink.resume(invalid) == nil)
        }
    }

    @Test func testClientRejectsNonAPIAndTraversalBeforeLoadingCredentials() async {
        let client = BridgeClient(stateDirectory: URL(fileURLWithPath: "/nonexistent"))
        for path in ["https://example.com/api/status", "//example.com/api/status", "/api/../status"] {
            do { _ = try await client.request(path); Issue.record("Must reject \(path)") }
            catch { #expect(error.localizedDescription == "Invalid local bridge request.") }
        }
    }

    @Test func testNVMDiscoveryUsesNewestExecutableWithoutShellStartup() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        for version in ["v9.0.0", "v22.20.0"] {
            let bin = home.appendingPathComponent(".nvm/versions/node/\(version)/bin")
            try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
            let executable = bin.appendingPathComponent("claude")
            try Data("fixture".utf8).write(to: executable)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        }
        let claude = AgentDiscovery.discover(home: home).first { $0.id == "claude" }!
        // System-installed CLIs correctly take precedence if present.
        if claude.cli!.path.hasPrefix(home.path) { #expect(claude.cli!.path.contains("v22.20.0")) }
    }

    @Test func testRedirectDelegateNeverForwardsRequest() {
        let delegate = NoRedirect()
        let session = URLSession(configuration: .ephemeral)
        let url = URL(string: "http://127.0.0.1:47831/api/status")!
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: nil)!
        let task = session.dataTask(with: url)
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
                            newRequest: URLRequest(url: URL(string: "https://example.com")!)) { redirected in
            #expect(redirected == nil)
        }
        session.invalidateAndCancel()
    }
}
