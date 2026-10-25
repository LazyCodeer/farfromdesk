import Foundation

// Never forward the local credential through an HTTP redirect or proxy.
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class BridgeClient: @unchecked Sendable {
    let stateDirectory: URL
    let baseURL: URL
    private let session: URLSession

    init(stateDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/WhatsApp Session Bridge"), port: Int = 47831) {
        self.stateDirectory = stateDirectory
        self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.connectionProxyDictionary = [:]
        config.httpCookieStorage = nil
        config.urlCache = nil
        self.session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }

    func request(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        guard path.hasPrefix("/api/"), !path.contains(".."),
              let url = URL(string: path, relativeTo: baseURL), url.host == "127.0.0.1" else {
            throw BridgeFailure.message("Invalid local bridge request.")
        }
        let tokenURL = stateDirectory.appendingPathComponent("admin-token")
        guard let token = try? String(contentsOf: tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw BridgeFailure.message("The background bridge has not been set up. Start it from Home.")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            let error = try? JSONDecoder().decode(APIError.self, from: data)
            throw BridgeFailure.message(error?.error ?? "The local bridge refused the request.")
        }
        guard data.count < 8 * 1024 * 1024 else { throw BridgeFailure.message("Bridge response is too large.") }
        return data
    }

    func status(catalogRevision: String? = nil) async throws -> BridgeStatus {
        var components = URLComponents()
        components.path = "/api/status"
        if let catalogRevision { components.queryItems = [URLQueryItem(name: "catalogRevision", value: catalogRevision)] }
        return try JSONDecoder().decode(BridgeStatus.self, from: await request(components.string!))
    }
    func sessions(provider: String, cursor: String? = nil) async throws -> SessionPage {
        var components = URLComponents()
        components.path = "/api/catalog"
        components.queryItems = [URLQueryItem(name: "provider", value: provider)]
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try JSONDecoder().decode(SessionPage.self, from: await request(components.string!))
    }
}
