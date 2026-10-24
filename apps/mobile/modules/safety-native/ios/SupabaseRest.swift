import Foundation

struct RestError: LocalizedError {
    let status: Int
    let body: String
    var errorDescription: String? { "HTTP \(status): \(body.prefix(300))" }
}

/// Tiny PostgREST / RPC / Edge Function client. Headers per CONTRACTS §2:
/// `apikey`, `Authorization: Bearer <accessToken>`, `Prefer: resolution=merge-duplicates` for upserts.
final class SupabaseRest {
    private let lock = NSLock()
    private var baseURL: URL?
    private var anonKey = ""
    private var accessToken = ""

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    var isConfigured: Bool { lock.lock(); defer { lock.unlock() }; return baseURL != nil && !accessToken.isEmpty }

    func configure(url: String, anonKey: String, accessToken: String) {
        lock.lock(); defer { lock.unlock() }
        baseURL = URL(string: url.hasSuffix("/") ? String(url.dropLast()) : url)
        self.anonKey = anonKey
        self.accessToken = accessToken
    }

    func setAccessToken(_ token: String) { lock.lock(); accessToken = token; lock.unlock() }

    // MARK: PostgREST

    /// INSERT (or UPSERT with `resolution=merge-duplicates`). `rows` is a dictionary or an array of them.
    @discardableResult
    func insert(_ table: String, _ rows: Any, upsert: Bool = false, returning: Bool = false) async throws -> [[String: Any]] {
        var prefer = [returning ? "return=representation" : "return=minimal"]
        if upsert { prefer.append("resolution=merge-duplicates") }
        let data = try await request(path: "/rest/v1/\(table)", method: "POST", body: rows, prefer: prefer.joined(separator: ","))
        return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
    }

    func patch(_ table: String, query: [String: String], _ body: [String: Any]) async throws {
        _ = try await request(path: "/rest/v1/\(table)", method: "PATCH", query: query, body: body, prefer: "return=minimal")
    }

    func select(_ table: String, query: [String: String]) async throws -> [[String: Any]] {
        let data = try await request(path: "/rest/v1/\(table)", method: "GET", query: query)
        return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
    }

    func rpc(_ fn: String, _ params: [String: Any]) async throws -> Any? {
        let data = try await request(path: "/rest/v1/rpc/\(fn)", method: "POST", body: params)
        let obj = try? JSONSerialization.jsonObject(with: data)
        return data.isEmpty ? nil : obj
    }

    /// Edge function: `POST {supabaseUrl}/functions/v1/{name}`.
    func function(_ name: String, _ body: [String: Any]) async throws -> Any? {
        let data = try await request(path: "/functions/v1/\(name)", method: "POST", body: body)
        let obj = try? JSONSerialization.jsonObject(with: data)
        return data.isEmpty ? nil : obj
    }

    // MARK: plumbing

    private func request(path: String, method: String, query: [String: String] = [:], body: Any? = nil, prefer: String? = nil) async throws -> Data {
        lock.lock()
        let base = baseURL, key = anonKey, token = accessToken
        lock.unlock()
        guard let base, var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw SafeError("Supabase not configured")
        }
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let url = comps.url else { throw SafeError("bad url") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw RestError(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }
}
