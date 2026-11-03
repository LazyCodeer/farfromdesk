// On-device sentence embeddings for app-tool retrieval.
//
// Why a separate binary: the tool shortlist is chosen before the model is asked, and the
// choice has to work with no API key and no network. NaturalLanguage's sentence embedding is
// local and keyless. Measured on 3 November 2026 on this Mac: 512 dimensions, about 10.5 ms
// per embedding, deterministic, no asset download (the model ships with the OS), and `swiftc
// -O` needs no extra frameworks.
//
// It is NOT a replacement for the lexical scorer. Measured on 16 realistic tool descriptions
// and 8 queries it scored 4/8 top-1, and "write a note about tomorrow's meeting" ranked the
// note tool seventh behind calendar, web search and mail. True-match cosines (0.32-0.72)
// overlapped the best false match (0.63), so no single score threshold separates them. This
// binary therefore ranks a candidate list that has already been narrowed; it never decides
// on its own.
//
// Protocol: one JSON object on stdin, one JSON object on stdout.
//   rank  : {"query":"...","docs":[{"id":"...","text":"..."}],"k":5}
//           -> {"ok":true,"model":"nl-sentence-512","ranked":[{"id":"...","score":0.61}]}
//   vectors: {"texts":["...","..."]}
//           -> {"ok":true,"model":"nl-sentence-512","vectors":[[...],[...]]}
//   both  : {"ok":false,"error":"..."}
// A missing model or a malformed request answers ok:false rather than pretending.
//
// The vectors mode exists so the caller can cache the pack's doc vectors per tool set and send
// only the owner's own words on a later turn. The callers do the cosine themselves in that
// mode, so these vectors are already L2-normalised and a dot product is the cosine.

import Foundation
import NaturalLanguage

struct Doc: Decodable {
    let id: String
    let text: String
}

struct Request: Decodable {
    let query: String?
    let docs: [Doc]?
    let k: Int?
    let texts: [String]?
}

struct Hit: Encodable {
    let id: String
    let score: Double
}

struct Response: Encodable {
    let ok: Bool
    let model: String
    let ranked: [Hit]?
    let vectors: [[Double]]?
    let error: String?
}

func emit(_ response: Response) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"model\":\"none\",\"error\":\"could not encode the answer\"}")
    }
}

func fail(_ message: String) -> Never {
    emit(Response(ok: false, model: "none", ranked: nil, vectors: nil, error: message))
    exit(0)
}

/// NaturalLanguage returns an unnormalised vector (measured L2 norms 6.48-8.78), so cosine
/// similarity has to be computed by hand; a raw dot product would rank by magnitude.
func normalized(_ vector: [Double]) -> [Double]? {
    var sum = 0.0
    for value in vector { sum += value * value }
    let length = sum.squareRoot()
    guard length > 0 else { return nil }
    return vector.map { $0 / length }
}

func cosine(_ a: [Double], _ b: [Double]) -> Double {
    guard a.count == b.count else { return 0 }
    var total = 0.0
    for index in 0..<a.count { total += a[index] * b[index] }
    return total
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input) else {
    fail("stdin was not a JSON request")
}
guard let embedding = NLEmbedding.sentenceEmbedding(for: .english) else {
    fail("this Mac has no English sentence embedding available")
}
let model = "nl-sentence-\(embedding.dimension)"

// Vectors mode: embed each text and hand back the normalised vectors, so the caller can cache
// them per tool set and score later turns itself.
if let texts = request.texts {
    var vectors: [[Double]] = []
    for text in texts {
        guard let vector = embedding.vector(for: text).flatMap({ normalized($0) }) else {
            fail("text \(vectors.count) could not be embedded")
        }
        vectors.append(vector)
    }
    emit(Response(ok: true, model: model, ranked: nil, vectors: vectors, error: nil))
    exit(0)
}

guard let query = request.query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fail("the query was empty")
}
guard let queryVector = embedding.vector(for: query).flatMap({ normalized($0) }) else {
    fail("the query could not be embedded")
}

var hits: [Hit] = []
for doc in request.docs ?? [] {
    guard let vector = embedding.vector(for: doc.text).flatMap({ normalized($0) }) else { continue }
    hits.append(Hit(id: doc.id, score: cosine(queryVector, vector)))
}
hits.sort { $0.score > $1.score }
let limit = max(1, min(request.k ?? 5, hits.count))
emit(Response(ok: true, model: model, ranked: Array(hits.prefix(limit)), vectors: nil, error: nil))
