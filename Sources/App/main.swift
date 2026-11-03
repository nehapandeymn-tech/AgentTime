// AgentTime: a floating, see-through corner widget where Finn (Claude), Jake (Antigravity) and BMO (Codex)
// act out what each agent is doing. This shell only moves bytes: it tails event logs, checks which tools are
// running, and hosts the web scene. All task logic lives in web/core.js.
import Cocoa
import WebKit

let home = FileManager.default.homeDirectoryForCurrentUser
let eventsDir = home.appendingPathComponent(".agent-companions/events")
let codexSessions = home.appendingPathComponent(".codex/sessions")
let claudeSettings = home.appendingPathComponent(".claude/settings.json")
let agyHooks = home.appendingPathComponent(".gemini/config/hooks.json")
let replayWindow: TimeInterval = 2 * 3600       // on launch, rebuild state from the last 2 hours (no celebrations)
let codexOrphanAge: TimeInterval = 30 * 60      // on launch only: an unfinished Codex turn idle this long is stale
let widgetSize = NSSize(width: 380, height: 156)

// MARK: - Serving the web scene from the bundle (custom scheme, so fetch() and images just work)

final class BundleScheme: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let rel = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(rel).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)); return
        }
        let types = ["html": "text/html", "js": "text/javascript", "json": "application/json", "png": "image/png"]
        let resp = URLResponse(url: url, mimeType: types[file.pathExtension] ?? "application/octet-stream",
                               expectedContentLength: data.count, textEncodingName: "utf-8")
        task.didReceive(resp); task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Window

final class Panel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class StageView: WKWebView {
    var onRightClick: ((NSEvent) -> Void)?
    var onMoved: (() -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    var onDrag: ((Bool) -> Void)?
    // Only reachable from the grab handle: everywhere else the panel ignores the mouse.
    override func mouseDown(with event: NSEvent) { onDrag?(true); window?.performDrag(with: event); onDrag?(false); onMoved?() }
    override func rightMouseDown(with event: NSEvent) { onRightClick?(event) }
    override func scrollWheel(with event: NSEvent) {}
}

// MARK: - Tailing append-only logs

struct Item: Encodable { let source: String; let line: String; let id: String; let session: String?; let replay: Bool }

final class Tail {
    let url: URL, source: String, session: String?
    var inode: UInt64 = 0, offset: UInt64 = 0, partial = Data()
    init(url: URL, source: String, session: String?) { self.url = url; self.source = source; self.session = session }

    /// Reads every complete new line up to the end of the file (in chunks, so a huge log is read in one go and
    /// history never leaks into "live"). `map` returns the line to forward, possibly slimmed down, or nil to drop it.
    func read(replay: Bool, map: (String) -> String? = { $0 }) -> [Item] {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = (attrs[.size] as? NSNumber)?.uint64Value,
              let ino = (attrs[.systemFileNumber] as? NSNumber)?.uint64Value else { return [] }
        if ino != inode || size < offset { inode = ino; offset = 0; partial = Data() }   // rotated or truncated
        guard size > offset, let fh = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? fh.close() }
        try? fh.seek(toOffset: offset)
        var items: [Item] = []
        while offset < size {
            let chunk = fh.readData(ofLength: Int(min(size - offset, 8_000_000)))
            if chunk.isEmpty { break }
            var buf = partial + chunk
            var lineStart = offset - UInt64(partial.count)
            while let nl = buf.firstIndex(of: 0x0A) {
                let lineData = buf[buf.startIndex..<nl]
                if let s = String(data: lineData, encoding: .utf8), !s.isEmpty, let out = map(s) {
                    items.append(Item(source: source, line: out, id: "\(ino):\(lineStart)", session: session, replay: replay))
                }
                lineStart += UInt64(lineData.count + 1)
                buf = buf[buf.index(after: nl)...]
            }
            partial = Data(buf)
            offset += UInt64(chunk.count)
        }
        return items
    }
    func skipToEnd() {
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) {
            inode = (attrs[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
            offset = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        }
    }
}

/// Codex logs hold whole conversations. Forward only the lifecycle events the companions use, reduced to
/// their type names, so message text, file contents and images never leave this process.
let codexPayloadType = try! NSRegularExpression(pattern: #""type":"event_msg","payload":\{"type":"([a-z_]+)""#)
let codexWanted: Set<String> = ["task_started", "task_complete", "turn_aborted", "item_completed", "exec_approval_request",
                                "apply_patch_approval_request", "request_user_input", "stream_error", "error"]
func slimCodexLine(_ s: String) -> String? {
    let head = String(s.prefix(400))
    guard let m = codexPayloadType.firstMatch(in: head, range: NSRange(head.startIndex..., in: head)),
          let r = Range(m.range(at: 1), in: head), codexWanted.contains(String(head[r])),
          let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any],
          let p = obj["payload"] as? [String: Any], let type = p["type"] as? String else { return nil }
    var payload: [String: Any] = ["type": type]
    for k in ["turn_id", "root_turn_id", "collaboration_mode_kind"] { if let v = p[k] as? String { payload[k] = v } }
    if let item = p["item"] as? [String: Any], let it = item["type"] as? String { payload["item"] = ["type": it] }
    var out: [String: Any] = ["type": "event_msg", "payload": payload]
    if let ts = obj["timestamp"] as? String { out["timestamp"] = ts }
    guard let d = try? JSONSerialization.data(withJSONObject: out) else { return nil }
    return String(data: d, encoding: .utf8)
}

// MARK: - App

final class Controller: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSMenuDelegate {
    var panel: Panel!
    var web: StageView!
    var status: NSStatusItem!
    var ready = false
    var tails: [String: Tail] = [:]
    var running: [String: Bool] = [:]
    var owners: [String: Int32] = [:]          // "provider|session" -> agent process id, from hook records
    var lastConn: [String: String] = [:]
    var hovering = false
    var dragging = false, faded = false, onHandle = false
    let handleHeight: CGFloat = 22            // the grab strip along the top of the widget
    var paused = false, encounters = false
    let snapshotPath: String?, snapshotJS: String?

    init(snapshot: String?, js: String?) { snapshotPath = snapshot; snapshotJS = js }

    func applicationDidFinishLaunching(_ n: Notification) {
        let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web")
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleScheme(root: webRoot), forURLScheme: "companions")
        config.userContentController.add(self, name: "companions")
        web = StageView(frame: NSRect(origin: .zero, size: widgetSize), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.onRightClick = { [weak self] e in self?.popMenu(e) }
        web.onMoved = { [weak self] in self?.savePosition() }
        web.onDrag = { [weak self] on in self?.dragging = on; if on { self?.setFaded(false) } }

        panel = Panel(contentRect: NSRect(origin: .zero, size: widgetSize), styleMask: [.borderless, .nonactivatingPanel],
                      backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.contentView = web
        panel.setFrameOrigin(savedOrigin())

        if snapshotPath != nil { panel.orderFrontRegardless(); web.load(URLRequest(url: URL(string: "companions://app/index.html")!)); return }

        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.image = finnFace(webRoot: webRoot)
            ?? NSImage(systemSymbolName: "figure.2.and.child.holdinghands", accessibilityDescription: "AgentTime")
        let menu = NSMenu(); menu.delegate = self; status.menu = menu

        if !UserDefaults.standard.bool(forKey: "hidden") { panel.orderFrontRegardless() }
        web.load(URLRequest(url: URL(string: "companions://app/index.html")!))

        Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.trackMouse() }
        Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.pump(initial: false) }
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.checkTools() }
        // What each companion shows right now, for debugging and other tools (status lines etc.).
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, self.ready else { return }
            self.web.evaluateJavaScript("JSON.stringify({at: new Date().toISOString(), companions: Companions.snapshotState()})") { out, _ in
                if let s = out as? String { try? s.write(to: eventsDir.deletingLastPathComponent().appendingPathComponent("state.json"), atomically: true, encoding: .utf8) }
            }
        }
        NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: panel, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.js("Companions.setVisible(\(self.panel.occlusionState.contains(.visible)))")
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.js("Companions.setReducedMotion(\(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))")
        }
    }

    /// Menu-bar icon: Finn's face, cut from his front-facing sprite (hat, ears and face; no shirt).
    func finnFace(webRoot: URL) -> NSImage? {
        guard let src = CGImageSourceCreateWithURL(webRoot.appendingPathComponent("sprites/finn-core.png") as CFURL, nil),
              let sheet = CGImageSourceCreateImageAtIndex(src, 0, nil),
              let face = sheet.cropping(to: CGRect(x: 40, y: 30, width: 117, height: 65)) else { return nil }
        let h: CGFloat = 16, w = (h * CGFloat(face.width) / CGFloat(face.height)).rounded()
        let img = NSImage(size: NSSize(width: w, height: h), flipped: false) { r in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(face, in: r)
            return true
        }
        img.isTemplate = false
        img.accessibilityDescription = "AgentTime"
        return img
    }

    // JS -> native
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard (message.body as? [String: Any])?["type"] as? String == "ready" else { return }
        ready = true
        if let out = snapshotPath { runSnapshot(out); return }
        js("Companions.setReducedMotion(\(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))")
        pump(initial: true)     // rebuild recent history first (no celebrations)...
        checkTools()            // ...then close whatever belongs to tools that aren't running
    }

    func js(_ s: String) { if ready { web.evaluateJavaScript(s, completionHandler: nil) } }

    // MARK: Feeding events

    func pump(initial: Bool) {
        guard ready else { return }
        var items: [Item] = []
        let cutoffMs = (Date().timeIntervalSince1970 - replayWindow) * 1000
        for p in ["claude", "antigravity"] {
            let url = eventsDir.appendingPathComponent("\(p).ndjson")
            let t = tails[url.path] ?? { let n = Tail(url: url, source: p, session: nil); tails[url.path] = n; return n }()
            if initial {
                items += t.read(replay: true) { line in
                    guard let ms = (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["received_ms"] as? Double else { return nil }
                    return ms >= cutoffMs ? line : nil
                }
            } else {
                items += t.read(replay: false)
            }
        }
        var stale: [String] = []
        for file in codexFiles() {
            let session = file.deletingPathExtension().lastPathComponent
            if let t = tails[file.path] { items += t.read(replay: false, map: slimCodexLine); continue }
            let t = Tail(url: file, source: "codex", session: session)
            tails[file.path] = t
            let mtime = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let age = Date().timeIntervalSince(mtime)
            if initial {
                if age < replayWindow {
                    items += t.read(replay: true, map: slimCodexLine)
                    if age > codexOrphanAge { stale.append(session) }
                } else { t.skipToEnd() }
            } else {
                items += t.read(replay: false, map: slimCodexLine)   // a session that started after launch: live from line one
            }
        }
        for it in items where it.source != "codex" { noteOwner(it) }
        if !items.isEmpty, let data = try? JSONEncoder().encode(items), let json = String(data: data, encoding: .utf8) {
            js("Companions.ingestBatch(\(json))")
        }
        for s in stale { js("Companions._store.providerStopped('codex', \(jsonString(s)))") }
    }

    func noteOwner(_ it: Item) {
        guard let o = try? JSONSerialization.jsonObject(with: Data(it.line.utf8)) as? [String: Any],
              let pid = (o["owner_pid"] as? NSNumber)?.int32Value, pid > 1,
              let sid = (o["session_id"] ?? o["conversationId"]) as? String else { return }
        let ended = (o["hook_event_name"] as? String) == "SessionEnd"
        owners["\(it.source)|\(sid)"] = ended ? nil : pid
    }

    func codexFiles() -> [URL] {
        let cal = Calendar.current
        var out: [URL] = []
        for back in 0...1 {
            guard let d = cal.date(byAdding: .day, value: -back, to: Date()) else { continue }
            let c = cal.dateComponents([.year, .month, .day], from: d)
            let dir = codexSessions.appendingPathComponent(String(format: "%04d/%02d/%02d", c.year!, c.month!, c.day!))
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            out += files.filter { $0.pathExtension == "jsonl" }
        }
        return out
    }

    // MARK: Tool health

    func hooksInstalled(_ url: URL) -> Bool {
        (try? String(contentsOf: url, encoding: .utf8))?.contains("companion-hook") ?? false
    }

    func checkTools() {
        guard ready else { return }
        let conn = [
            "claude": hooksInstalled(claudeSettings) ? "healthy" : "unavailable",
            "antigravity": hooksInstalled(agyHooks) ? "healthy" : "unavailable",
            "codex": FileManager.default.fileExists(atPath: codexSessions.path) ? "healthy" : "unavailable",
        ]
        for (p, s) in conn where lastConn[p] != s { js("Companions.setConnection('\(p)', '\(s)')"); lastConn[p] = s }

        // A tool's process exiting closes its open work quietly. (Codex runs as a background service,
        // so its log is the only signal; its process can't tell busy from idle.)
        // A session whose own agent process has exited is over, even without a clean stop event.
        for (key, pid) in owners where kill(pid, 0) != 0 && errno == ESRCH {
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            js("Companions._store.providerStopped('\(parts[0])', \(jsonString(parts[1])))")
            owners[key] = nil
        }
        let names = processNames()
        for (p, exe) in [("claude", "claude"), ("antigravity", "agy")] {
            let now = names.contains(exe)
            if running[p] != false && !now { js("Companions.providerStopped('\(p)')") }   // also at launch: replayed work of a tool that isn't running is over
            running[p] = now
        }
    }

    func processNames() -> Set<String> {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-axo", "comm="]
        let pipe = Pipe(); task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return Set((String(data: data, encoding: .utf8) ?? "").split(separator: "\n").map { ($0 as NSString).lastPathComponent })
    }

    // MARK: Mouse: click-through except over the widget; hover details

    /// The widget never gets in the way: over the top grab strip it is solid and can be dragged (or
    /// right-clicked); anywhere else on it, it fades out and clicks go straight through to what's behind.
    func trackMouse() {
        guard panel.isVisible, !dragging else { return }
        let m = NSEvent.mouseLocation, f = panel.frame
        let inside = f.contains(m)
        let handle = inside && m.y >= f.maxY - handleHeight
        if panel.ignoresMouseEvents == handle { panel.ignoresMouseEvents = !handle }
        setFaded(inside && !handle)
        if handle != onHandle { onHandle = handle; js("Companions.setHandle(\(handle))") }
    }

    func setFaded(_ on: Bool) {
        guard on != faded else { return }
        faded = on
        let target: CGFloat = on ? 0.15 : 1
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { panel.alphaValue = target; return }
        NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.18; panel.animator().alphaValue = target }
    }

    func savedOrigin() -> NSPoint {
        let d = UserDefaults.standard
        if d.object(forKey: "x") != nil {
            let p = NSPoint(x: d.double(forKey: "x"), y: d.double(forKey: "y"))
            if NSScreen.screens.contains(where: { $0.visibleFrame.insetBy(dx: -20, dy: -20).contains(p) }) { return p }
        }
        let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        return NSPoint(x: vf.maxX - widgetSize.width - 16, y: vf.minY + 16)
    }
    func savePosition() {
        UserDefaults.standard.set(panel.frame.minX, forKey: "x")
        UserDefaults.standard.set(panel.frame.minY, forKey: "y")
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let head = NSMenuItem(title: "AgentTime", action: nil, keyEquivalent: ""); head.isEnabled = false
        menu.addItem(head)
        for (name, ok, how) in [("Claude · Finn", hooksInstalled(claudeSettings), "hooks"),
                                 ("Antigravity · Jake", hooksInstalled(agyHooks), "hooks"),
                                 ("Codex · BMO", FileManager.default.fileExists(atPath: codexSessions.path), "session logs")] {
            let i = NSMenuItem(title: "    \(name): \(ok ? "live via \(how)" : "not connected")", action: nil, keyEquivalent: "")
            i.isEnabled = false; menu.addItem(i)
        }
        menu.addItem(.separator())
        menu.addItem(item(panel.isVisible ? "Hide Companions" : "Show Companions", #selector(toggleShown)))
        menu.addItem(toggle("Pause Animations", paused, #selector(togglePause)))
        menu.addItem(toggle("Ice King on Tough Tasks", encounters, #selector(toggleEncounters)))
        menu.addItem(item("Clear Failure Labels", #selector(clearFailures)))
        menu.addItem(item("Move to Bottom-Right Corner", #selector(resetPosition)))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit AgentTime", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }
    func popMenu(_ e: NSEvent) {
        let menu = NSMenu(); menu.delegate = self; menuNeedsUpdate(menu)
        NSMenu.popUpContextMenu(menu, with: e, for: web)
    }
    func item(_ t: String, _ s: Selector) -> NSMenuItem { let i = NSMenuItem(title: t, action: s, keyEquivalent: ""); i.target = self; return i }
    func toggle(_ t: String, _ on: Bool, _ s: Selector) -> NSMenuItem { let i = item(t, s); i.state = on ? .on : .off; return i }

    @objc func toggleShown() {
        let hide = panel.isVisible
        UserDefaults.standard.set(hide, forKey: "hidden")
        if hide { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
        js("Companions.setVisible(\(!hide))")
    }
    @objc func togglePause() { paused.toggle(); js("Companions.setPaused(\(paused))") }
    @objc func toggleEncounters() { encounters.toggle(); js("Companions.setEncounters(\(encounters))") }
    @objc func clearFailures() { js("Companions.acknowledgeFailures()") }
    @objc func resetPosition() {
        UserDefaults.standard.removeObject(forKey: "x"); UserDefaults.standard.removeObject(forKey: "y")
        panel.setFrameOrigin(savedOrigin())
    }

    // MARK: Snapshot (development): Agent\ Companions --snapshot out.png --js "<script>"

    func runSnapshot(_ out: String) {
        web.evaluateJavaScript(snapshotJS ?? "", completionHandler: nil)
        let wait = Double(ProcessInfo.processInfo.environment["SNAP_WAIT"] ?? "2.5") ?? 2.5
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
            let cfg = WKSnapshotConfiguration()
            self.web.takeSnapshot(with: cfg) { img, _ in
                if let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: URL(fileURLWithPath: out)) }
                print("wrote \(out)")
                exit(0)
            }
        }
    }
}

func jsonString(_ s: String) -> String {
    String(data: try! JSONEncoder().encode(s), encoding: .utf8)!
}

let args = CommandLine.arguments
func arg(_ k: String) -> String? { args.firstIndex(of: k).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
let app = NSApplication.shared
let controller = Controller(snapshot: arg("--snapshot"), js: arg("--js"))
app.delegate = controller
app.setActivationPolicy(.accessory)
app.run()
