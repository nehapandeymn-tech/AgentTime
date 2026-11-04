// companion-hook: called by Claude Code and Antigravity hooks. Appends one small, allow-listed record to
// ~/.agent-companions/events/<provider>.ndjson and exits immediately. Watch-only: it never blocks, approves,
// denies or changes anything. Prompts, file contents and command text are never written.
//
//   companion-hook claude                 (Claude Code: event name arrives in the JSON as hook_event_name)
//   companion-hook antigravity <Event>    (Antigravity: SessionStart | PreInvocation | PostToolUse | Stop)
//   companion-hook statusline <claude|antigravity> [chained command]
//       (status line: saves only the plan-limit numbers to ~/.agent-companions/limits/ for the health bars,
//        then prints a short "how much is left" line, or the output of the user's own status line command)
import Foundation

let args = CommandLine.arguments
let provider = args.count > 1 ? args[1] : ""
let agyEvent = args.count > 2 ? args[2] : ""

if provider == "statusline" { statusLine(args.count > 2 ? args[2] : "claude", chained: args.count > 3 ? args[3] : nil); exit(0) }

func pct(_ f: Double) -> String { "\(Int((f * 100).rounded()))%" }

/// Status line mode. Keeps nothing but bucket names, fractions left and reset times.
func statusLine(_ tool: String, chained: String?) {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let obj = (try? JSONSerialization.jsonObject(with: input) as? [String: Any]) ?? [:]
    var buckets: [[String: Any]] = []
    var account = ""
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    if tool == "claude" {
        // One file per Claude config folder, so two accounts (CLAUDE_CONFIG_DIR) get two bars.
        let dir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"].map { ($0 as NSString).expandingTildeInPath } ?? home + "/.claude"
        account = URL(fileURLWithPath: dir).standardizedFileURL.path
        let rl = obj["rate_limits"] as? [String: Any] ?? [:]
        for (key, name) in [("five_hour", "5h"), ("seven_day", "week")] {
            guard let b = rl[key] as? [String: Any], let used = (b["used_percentage"] as? NSNumber)?.doubleValue else { continue }
            var e: [String: Any] = ["name": name, "left": max(0, min(1, 1 - used / 100))]
            if let r = (b["resets_at"] as? NSNumber)?.doubleValue { e["resets_at"] = r }
            buckets.append(e)
        }
    } else {
        account = (obj["email"] as? String).map { String($0.prefix(120)) } ?? "default"
        let model = ((obj["model"] as? [String: Any])?["id"] as? String ?? "").lowercased()
        let iso = ISO8601DateFormatter()
        for (key, v) in (obj["quota"] as? [String: Any] ?? [:]) {
            guard let b = v as? [String: Any], let left = (b["remaining_fraction"] as? NSNumber)?.doubleValue else { continue }
            var e: [String: Any] = ["name": String(key.prefix(40)), "left": max(0, min(1, left)),
                                    "group": key.hasPrefix("gemini") ? "gemini" : "other"]
            if let r = (b["reset_time"] as? String).flatMap({ iso.date(from: $0) }) { e["resets_at"] = r.timeIntervalSince1970 }
            buckets.append(e)
        }
        if !buckets.isEmpty { buckets.sort { "\($0["name"]!)" < "\($1["name"]!)" } }
        _ = model
    }
    if !buckets.isEmpty {
        var rec: [String: Any] = ["provider": tool, "account": account, "buckets": buckets, "at": Date().timeIntervalSince1970]
        if tool == "antigravity", let m = (obj["model"] as? [String: Any])?["id"] as? String {
            rec["active_group"] = m.lowercased().contains("gemini") ? "gemini" : "other"
        }
        let dir = URL(fileURLWithPath: home + "/.agent-companions/limits")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = account.map { $0.isLetter || $0.isNumber ? $0 : "_" }
        if let d = try? JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys]) {
            try? d.write(to: dir.appendingPathComponent("\(tool)-\(String(safe)).json"), options: .atomic)
        }
    }
    // The user's own status line keeps working: run it with the same input and show its output instead.
    if let cmd = chained, !cmd.isEmpty {
        let t = Process(); t.executableURL = URL(fileURLWithPath: "/bin/sh"); t.arguments = ["-c", cmd]
        let inPipe = Pipe(); t.standardInput = inPipe
        if (try? t.run()) != nil { inPipe.fileHandleForWriting.write(input); try? inPipe.fileHandleForWriting.close(); t.waitUntilExit() }
        return
    }
    let shown = buckets.filter { ($0["group"] as? String ?? "gemini") == "gemini" || tool == "claude" }
    let parts = shown.map { "\($0["name"]!) \(pct(($0["left"] as? Double) ?? 0)) left" }
    print(parts.isEmpty ? "AgentTime" : "♥ " + parts.joined(separator: " · "))
}

// Antigravity hooks run synchronously and expect JSON on stdout. Reply first so nothing below can delay it.
if provider == "antigravity" {
    print(agyEvent == "Stop" ? #"{"decision":"stop"}"# : "{}")
    fflush(stdout)
}

func clip(_ v: Any?, _ n: Int) -> String? { (v as? String).map { String($0.prefix(n)) } }

/// The agent process that ran this hook (skipping the shell in between), so the widget can tell when that
/// exact session has gone away even if it never sent a clean "stop".
func ownerPID() -> Int32 {
    var pid = getppid()
    for _ in 0..<3 {
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 else { break }
        let name = withUnsafePointer(to: info.pbi_comm) { $0.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) } }
        if !["sh", "bash", "zsh", "dash", "env"].contains(name) { return pid }
        pid = Int32(info.pbi_ppid)
    }
    return pid
}

func record(_ input: [String: Any]) -> [String: Any]? {
    var r: [String: Any] = [:]
    switch provider {
    case "claude":
        guard let ev = input["hook_event_name"] as? String, let sid = input["session_id"] as? String else { return nil }
        r["hook_event_name"] = ev
        r["session_id"] = sid
        for k in ["prompt_id", "tool_name", "tool_use_id", "permission_mode", "agent_id", "notification_type"] {
            if let v = clip(input[k], 120) { r[k] = v }
        }
        if let b = input["is_interrupt"] as? Bool { r["is_interrupt"] = b }
        if ev == "Notification", let m = clip(input["message"], 80) { r["message"] = m }   // e.g. "Claude needs your permission…"
    case "antigravity":
        guard !agyEvent.isEmpty, let cid = input["conversationId"] as? String else { return nil }
        r["event"] = agyEvent
        r["conversationId"] = cid
        if let s = input["stepIdx"] { r["stepIdx"] = s }
        if let tc = input["toolCall"] as? [String: Any], let name = clip(tc["name"], 80) { r["tool"] = name }
        if let e = input["error"], !(e is NSNull), "\(e)" != "" { r["error"] = true }
        if let n = input["invocationNum"] { r["invocationNum"] = n }
    default:
        return nil
    }
    let now = Date()
    r["owner_pid"] = Int(ownerPID())
    r["received_ms"] = Int(now.timeIntervalSince1970 * 1000)
    r["received_at"] = ISO8601DateFormatter().string(from: now)
    return r
}

let data = FileHandle.standardInput.readDataToEndOfFile()
if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let rec = record(obj),
   var line = try? JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys]) {
    line.append(0x0A)
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agent-companions/events")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let path = dir.appendingPathComponent("\(provider).ndjson").path
    // Keep the log small: start a fresh file past 4 MB (the widget follows the new file).
    if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > 4_000_000 {
        try? FileManager.default.removeItem(atPath: path + ".1")
        try? FileManager.default.moveItem(atPath: path, toPath: path + ".1")
    }
    let fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
    if fd >= 0 {
        _ = line.withUnsafeBytes { write(fd, $0.baseAddress, line.count) }   // one write: lines never interleave
        close(fd)
    }
}
exit(0)
