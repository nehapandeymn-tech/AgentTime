// companion-hook: called by Claude Code and Antigravity hooks. Appends one small, allow-listed record to
// ~/.agent-companions/events/<provider>.ndjson and exits immediately. Watch-only: it never blocks, approves,
// denies or changes anything. Prompts, file contents and command text are never written.
//
//   companion-hook claude                 (Claude Code: event name arrives in the JSON as hook_event_name)
//   companion-hook antigravity <Event>    (Antigravity: SessionStart | PreInvocation | PostToolUse | Stop)
import Foundation

let args = CommandLine.arguments
let provider = args.count > 1 ? args[1] : ""
let agyEvent = args.count > 2 ? args[2] : ""

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
