// Plan limits: how much of each account's usage allowance is left (the health bars), and whether an
// agent has run out on every account (the tombstone). Read-only and numbers only.
//
//   Claude Code  ~/.agent-companions/limits/claude-*.json, written by the status line (companion-hook
//                statusline claude): the 5-hour and weekly limits, one file per config folder (= account).
//   Antigravity  ~/.agent-companions/limits/antigravity-*.json, from its status line: 5-hour and weekly
//                quota for Gemini models and for other models.
//   Codex        the newest `rate_limits` in its session logs.
import Foundation

let limitsDir = home.appendingPathComponent(".agent-companions/limits")

struct Account: Codable, Equatable {
    var name: String
    var known: Bool                 // false: no numbers yet (never used, or no status line run yet)
    var left: Double = 1            // 0…1 of the tightest limit
    var limit: String = ""          // which limit that is ("5h", "week")
    var dead = false                // nothing left to work with on this account
    var resetsAt: Double? = nil     // when it comes back (epoch seconds), if dead
}

struct Bucket { let name: String; let left: Double; let resetsAt: Double?; let group: String }

/// A bucket that has already reset is full again, even if the last reading said otherwise.
func current(_ b: Bucket, now: Double) -> Double {
    if let r = b.resetsAt, r <= now { return 1 }
    return b.left
}

/// Tightest bucket in a group, and when that group would be usable again if it's empty.
func summarize(_ buckets: [Bucket], now: Double) -> (left: Double, limit: String, dead: Bool, back: Double?) {
    guard let tight = buckets.min(by: { current($0, now: now) < current($1, now: now) }) else { return (1, "", false, nil) }
    let empties = buckets.filter { current($0, now: now) <= 0.001 }
    let back = empties.compactMap(\.resetsAt).max()            // every empty bucket has to reset
    return (current(tight, now: now), tight.name, !empties.isEmpty, back)
}

func readJSON(_ url: URL) -> [String: Any]? {
    (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
}
func buckets(_ rec: [String: Any]) -> [Bucket] {
    (rec["buckets"] as? [[String: Any]] ?? []).compactMap { b in
        guard let name = b["name"] as? String, let left = (b["left"] as? NSNumber)?.doubleValue else { return nil }
        return Bucket(name: name, left: left, resetsAt: (b["resets_at"] as? NSNumber)?.doubleValue, group: b["group"] as? String ?? "")
    }
}
func safeName(_ s: String) -> String { String(s.map { $0.isLetter || $0.isNumber ? $0 : "_" }) }

// MARK: Claude Code accounts: ~/.claude plus every CLAUDE_CONFIG_DIR a shell alias uses.

func claudeAccounts() -> [(dir: String, name: String)] {
    let defaultDir = home.appendingPathComponent(".claude").path
    var found: [(String, String?)] = [(defaultDir, nil)]
    let alias = try! NSRegularExpression(pattern: #"^\s*alias\s+([\w-]+)=(['"])(.*)\2"#)
    for rc in [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"] {
        guard let text = try? String(contentsOf: home.appendingPathComponent(rc), encoding: .utf8) else { continue }
        for line in text.split(separator: "\n").map(String.init) {
            guard let m = alias.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
                  let n = Range(m.range(at: 1), in: line), let c = Range(m.range(at: 3), in: line) else { continue }
            let cmd = String(line[c])
            guard cmd.range(of: #"\bclaude\b"#, options: .regularExpression) != nil else { continue }
            var dir = defaultDir
            if let r = cmd.range(of: #"CLAUDE_CONFIG_DIR=\S+"#, options: .regularExpression) {
                let v = cmd[r].dropFirst("CLAUDE_CONFIG_DIR=".count).trimmingCharacters(in: CharacterSet(charactersIn: "'\""))
                dir = URL(fileURLWithPath: (v as NSString).expandingTildeInPath).standardizedFileURL.path
            }
            if let i = found.firstIndex(where: { $0.0 == dir }) { if found[i].1 == nil { found[i].1 = String(line[n]) } }
            else { found.append((dir, String(line[n]))) }
        }
    }
    // Your own names and order win: ~/.agent-companions/accounts.json
    //   {"claude": [{"dir": "~/.claude", "name": "work"}, {"dir": "~/.personal", "name": "personal"}]}
    if let o = readJSON(home.appendingPathComponent(".agent-companions/accounts.json")),
       let list = o["claude"] as? [[String: Any]] {
        var ordered: [(String, String?)] = []
        for e in list {
            guard let d = e["dir"] as? String else { continue }
            let dir = URL(fileURLWithPath: (d as NSString).expandingTildeInPath).standardizedFileURL.path
            ordered.append((dir, e["name"] as? String ?? found.first(where: { $0.0 == dir })?.1))
        }
        found = ordered + found.filter { f in !ordered.contains(where: { $0.0 == f.0 }) }
    }
    return found.filter { FileManager.default.fileExists(atPath: $0.0) }
        .map { ($0.0, $0.1 ?? (URL(fileURLWithPath: $0.0).lastPathComponent.trimmingCharacters(in: CharacterSet(charactersIn: ".")))) }
}

/// The Claude login a config folder holds (its .claude.json; the default folder keeps it at ~/.claude.json).
/// A folder nobody ever signed in to has none and gets no bar.
func claudeLogin(_ dir: String) -> String? {
    let defaultDir = home.appendingPathComponent(".claude").path
    let files = dir == defaultDir ? [home.appendingPathComponent(".claude.json"), URL(fileURLWithPath: dir + "/.claude.json")]
                                  : [URL(fileURLWithPath: dir + "/.claude.json")]
    for f in files {
        if let a = readJSON(f)?["oauthAccount"] as? [String: Any], let e = a["emailAddress"] as? String, !e.isEmpty { return e }
    }
    return nil
}

func claudeLimits(now: Double) -> [Account] {
    claudeAccounts().filter { claudeLogin($0.dir) != nil }.map { acct in
        let file = limitsDir.appendingPathComponent("claude-\(safeName(acct.dir)).json")
        guard let rec = readJSON(file) else { return Account(name: acct.name, known: false) }
        let s = summarize(buckets(rec), now: now)
        return Account(name: acct.name, known: true, left: s.left, limit: s.limit, dead: s.dead, resetsAt: s.dead ? s.back : nil)
    }
}

// MARK: Antigravity: one file per signed-in Google account. Alive while either model group has room.

func antigravityLimits(now: Double) -> [Account] {
    let files = ((try? FileManager.default.contentsOfDirectory(at: limitsDir, includingPropertiesForKeys: nil)) ?? [])
        .filter { $0.lastPathComponent.hasPrefix("antigravity-") }.sorted { $0.path < $1.path }
    return files.compactMap { f in
        guard let rec = readJSON(f) else { return nil }
        let all = buckets(rec)
        let active = rec["active_group"] as? String ?? "gemini"
        let groups = Dictionary(grouping: all, by: \.group).mapValues { summarize($0, now: now) }
        let shown = groups[active] ?? summarize(all, now: now)
        let dead = !groups.isEmpty && groups.values.allSatisfy(\.dead)
        let back = dead ? groups.values.compactMap(\.back).min() : nil
        let email = rec["account"] as? String ?? ""
        let name = String(email.split(separator: "@").first ?? "")
        return Account(name: name, known: true, left: shown.left, limit: shown.limit.replacingOccurrences(of: "gemini-", with: ""),
                       dead: dead, resetsAt: back)
    }
}

// MARK: Codex: the latest rate_limits it logged (primary and secondary windows).

func codexLimits(files: [URL], now: Double) -> [Account] {
    let sorted = files.compactMap { u -> (URL, Date)? in
        (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate.map { (u, $0) }
    }.sorted { $0.1 > $1.1 }.prefix(4)
    for (file, _) in sorted {
        for line in tailLines(file) where line.contains("\"rate_limits\"") {
            guard let o = jsonObject(line), let p = o["payload"] as? [String: Any],
                  let rl = p["rate_limits"] as? [String: Any] else { continue }
            var bs: [Bucket] = []
            for key in ["primary", "secondary"] {
                guard let w = rl[key] as? [String: Any], let used = (w["used_percent"] as? NSNumber)?.doubleValue else { continue }
                let mins = (w["window_minutes"] as? NSNumber)?.intValue ?? 0
                let name = mins >= 1440 * 6 ? "week" : mins >= 60 ? "\(mins / 60)h" : "\(mins)m"
                bs.append(Bucket(name: name, left: max(0, 1 - used / 100), resetsAt: (w["resets_at"] as? NSNumber)?.doubleValue, group: ""))
            }
            guard !bs.isEmpty else { continue }
            var s = summarize(bs, now: now)
            if rl["rate_limit_reached_type"] is String, !s.dead {   // Codex says so itself
                s.dead = true; s.left = 0; s.back = bs.compactMap(\.resetsAt).max()
            }
            return [Account(name: "", known: true, left: s.left, limit: s.limit, dead: s.dead, resetsAt: s.dead ? s.back : nil)]
        }
    }
    return []
}

// MARK: Helpers

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
