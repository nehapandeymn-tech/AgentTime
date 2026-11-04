// Token meters: how much of each agent's context window is left in its most recent session.
// Read-only, numbers only: we read token counts from each tool's own local logs and never keep
// prompts, code or anything else from them.
import Foundation
import SQLite3

struct Meter: Codable, Equatable { let used: Int; let window: Int }

let meterMaxAge: TimeInterval = 24 * 3600          // an older session isn't "what's left" any more

/// The most recently modified file among `urls`, if it's fresh enough to count.
func newestFresh(_ urls: [URL]) -> URL? {
    let dated = urls.compactMap { u -> (URL, Date)? in
        guard let d = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else { return nil }
        return (u, d)
    }
    guard let best = dated.max(by: { $0.1 < $1.1 }), Date().timeIntervalSince(best.1) < meterMaxAge else { return nil }
    return best.0
}

/// The last `bytes` of a file, split into lines, newest first (a partial first line is dropped).
func tailLines(_ url: URL, bytes: Int = 1 << 20) -> [Substring] {
    guard let h = try? FileHandle(forReadingFrom: url) else { return [] }
    defer { try? h.close() }
    let size = (try? h.seekToEnd()) ?? 0
    let start = size > UInt64(bytes) ? size - UInt64(bytes) : 0
    try? h.seek(toOffset: start)
    guard let data = try? h.readToEnd(), let s = String(data: data, encoding: .utf8) else { return [] }
    var lines = s.split(separator: "\n", omittingEmptySubsequences: true)
    if start > 0, !lines.isEmpty { lines.removeFirst() }
    return lines.reversed()
}

func jsonObject(_ line: Substring) -> [String: Any]? {
    try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
}
func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? 0 }

// MARK: Claude Code: the latest main-thread assistant message's usage in the newest transcript.

func claudeMeter() -> Meter? {
    let root = home.appendingPathComponent(".claude/projects")
    let fm = FileManager.default
    var files: [URL] = []
    for dir in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
        files += ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.pathExtension == "jsonl" }
    }
    guard let file = newestFresh(files) else { return nil }
    var used = 0, peak = 0
    for line in tailLines(file) where line.contains("\"usage\"") {
        guard let o = jsonObject(line), o["type"] as? String == "assistant", o["isSidechain"] as? Bool != true,
              let u = (o["message"] as? [String: Any])?["usage"] as? [String: Any] else { continue }
        let n = int(u["input_tokens"]) + int(u["cache_read_input_tokens"]) + int(u["cache_creation_input_tokens"]) + int(u["output_tokens"])
        if n == 0 { continue }                      // synthetic / error messages carry no usage
        if used == 0 { used = n }
        peak = max(peak, n)
    }
    guard used > 0 else { return nil }
    // Claude Code doesn't log the window size; a session that has ever gone past 200k is on the 1M window.
    return Meter(used: used, window: peak > 200_000 ? 1_000_000 : 200_000)
}

// MARK: Codex: the last token_count event (it logs its own window size).

func codexMeter(files: [URL]) -> Meter? {
    guard let file = newestFresh(files) else { return nil }
    for line in tailLines(file) where line.contains("\"token_count\"") {
        guard let o = jsonObject(line), let p = o["payload"] as? [String: Any],
              let info = p["info"] as? [String: Any], let last = info["last_token_usage"] as? [String: Any] else { continue }
        let window = int(info["model_context_window"])
        let used = int(last["total_tokens"])
        if window > 0 { return Meter(used: used, window: window) }
    }
    return nil
}

// MARK: Antigravity: the newest conversation database's latest generation metadata (protobuf).

func antigravityMeter() -> Meter? {
    let dir = home.appendingPathComponent(".gemini/antigravity-cli/conversations")
    let dbs = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
        .filter { $0.pathExtension == "db" }
    guard let file = newestFresh(dbs) else { return nil }
    var db: OpaquePointer?
    guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { sqlite3_close(db); return nil }
    defer { sqlite3_close(db) }
    sqlite3_busy_timeout(db, 200)
    var st: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1", -1, &st, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(st) }
    guard sqlite3_step(st) == SQLITE_ROW, let blob = sqlite3_column_blob(st, 0) else { return nil }
    let bytes = [UInt8](UnsafeRawBufferPointer(start: blob, count: Int(sqlite3_column_bytes(st, 0))))
    // Usage lives at 1 › 9 › 10: field 1 is the tokens in the prompt, field 4 the model's window.
    var found: [Int: Int] = [:]
    protoVarints(bytes[...], path: [], into: { path, v in
        if path.count == 4, path[0] == 1, path[1] == 9, path[2] == 10, path[3] == 1 || path[3] == 4 { found[path[3]] = v }
    })
    guard let used = found[1], let window = found[4], window > 0 else { return nil }
    return Meter(used: used, window: window)
}

/// Walks a protobuf message without its schema, reporting every varint with its field path.
/// Length-delimited fields are tried as nested messages and skipped if they don't parse as one.
@discardableResult
func protoVarints(_ b: ArraySlice<UInt8>, path: [Int], depth: Int = 0, into report: ([Int], Int) -> Void) -> Bool {
    func varint(_ i: inout Int) -> Int? {
        var r = 0, s = 0
        while i < b.endIndex, s < 64 {
            let c = b[i]; i += 1
            r |= Int(c & 0x7f) << s; s += 7
            if c < 0x80 { return r }
        }
        return nil
    }
    var i = b.startIndex
    var pending: [([Int], Int)] = []
    while i < b.endIndex {
        guard let key = varint(&i) else { return false }
        let field = key >> 3
        guard field > 0 else { return false }
        switch key & 7 {
        case 0: guard let v = varint(&i) else { return false }; pending.append((path + [field], v))
        case 1: i += 8
        case 5: i += 4
        case 2:
            guard let n = varint(&i), n >= 0, i + n <= b.endIndex else { return false }
            if depth < 8, n > 0 {
                var nested: [([Int], Int)] = []
                if protoVarints(b[i..<(i + n)], path: path + [field], depth: depth + 1, into: { nested.append(($0, $1)) }) { pending += nested }
            }
            i += n
        default: return false
        }
    }
    guard i == b.endIndex else { return false }
    for (p, v) in pending { report(p, v) }
    return true
}
