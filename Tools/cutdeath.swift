// Cuts the "out of tokens" sheet (3 rows: Finn, Jake, BMO; 6 frames each: tired, slump, collapse,
// poof, tombstone rising, tombstone) off its dark glowing backdrop into a transparent atlas.
// swift Tools/cutdeath.swift <sheet.png> <out.png> <out-frames.json>
import AppKit

let a = CommandLine.arguments
let src = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: a[1])))!
let W = src.pixelsWide, H = src.pixelsHigh
var rgb = [UInt8](repeating: 0, count: W * H * 3)
do {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(src.cgImage!, in: CGRect(x: 0, y: 0, width: W, height: H))
    let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
    for i in 0..<(W * H) { rgb[i * 3] = p[i * 4]; rgb[i * 3 + 1] = p[i * 4 + 1]; rgb[i * 3 + 2] = p[i * 4 + 2] }
}
func mx(_ i: Int) -> Int { Int(max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])) }
func mn(_ i: Int) -> Int { Int(min(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])) }
let darkT = Int(a.count > 4 ? a[4] : "40")!
func dark(_ i: Int) -> Bool { mx(i) < darkT }

// 1. Background = everything reachable from the cell borders without crossing the black outline.
let cols = 6
let rowsY: [(Int, Int)] = [(20, 300), (300, 560), (560, 830)]
var bg = [Bool](repeating: false, count: W * H)
var cellOf = [Int](repeating: -1, count: W * H)
for (r, band) in rowsY.enumerated() {
    for c in 0..<cols {
        let x0 = c * W / cols, x1 = (c + 1) * W / cols
        var stack: [Int] = []
        for x in x0..<x1 { stack.append(band.0 * W + x); stack.append((band.1 - 1) * W + x) }
        for y in band.0..<band.1 { stack.append(y * W + x0); stack.append(y * W + x1 - 1) }
        for y in band.0..<band.1 { for x in x0..<x1 { cellOf[y * W + x] = r * cols + c } }
        while let i = stack.popLast() {
            if bg[i] || dark(i) { continue }
            bg[i] = true
            let x = i % W, y = i / W
            if x > x0 { stack.append(i - 1) }; if x < x1 - 1 { stack.append(i + 1) }
            if y > band.0 { stack.append(i - W) }; if y < band.1 - 1 { stack.append(i + W) }
        }
    }
}
// 2. Sprite fill = bright pixels not reached. Outline = dark pixels within `R` px of the fill.
var fill = [Bool](repeating: false, count: W * H)
for i in 0..<(W * H) where cellOf[i] >= 0 && !bg[i] && !dark(i) { fill[i] = true }
let R = Int(a.count > 5 ? a[5] : "9")!
var dist = [Int](repeating: Int.max, count: W * H)
var queue: [Int] = []
for i in 0..<(W * H) where fill[i] { dist[i] = 0; queue.append(i) }
var head = 0
while head < queue.count {
    let i = queue[head]; head += 1
    let d = dist[i]; if d >= R { continue }
    let x = i % W, y = i / W
    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        let nx = x + dx, ny = y + dy
        guard nx >= 0, ny >= 0, nx < W, ny < H else { continue }
        let j = ny * W + nx
        if dist[j] == Int.max, dark(j), cellOf[j] == cellOf[i] { dist[j] = d + 1; queue.append(j) }
    }
}
// 3. Write the cut sheet and each cell's bounding box.
let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: W * 4, bitsPerPixel: 32)!
let o = out.bitmapData!
var boxes = [[Int]](repeating: [Int.max, Int.max, -1, -1], count: 3 * cols)
for i in 0..<(W * H) {
    let keep = fill[i] || (dist[i] <= R && dist[i] > 0)
    if keep {
        let isOutline = !fill[i]
        o[i * 4] = isOutline ? 0 : rgb[i * 3]; o[i * 4 + 1] = isOutline ? 0 : rgb[i * 3 + 1]
        o[i * 4 + 2] = isOutline ? 0 : rgb[i * 3 + 2]; o[i * 4 + 3] = 255
        let c = cellOf[i], x = i % W, y = i / W
        boxes[c][0] = min(boxes[c][0], x); boxes[c][1] = min(boxes[c][1], y)
        boxes[c][2] = max(boxes[c][2], x); boxes[c][3] = max(boxes[c][3], y)
    } else { o[i * 4 + 3] = 0 }
}
try! out.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
let json = boxes.map { "[\($0[0]),\($0[1]),\($0[2] - $0[0] + 1),\($0[3] - $0[1] + 1)]" }.joined(separator: ",")
try! "[\(json)]".write(toFile: a[3], atomically: true, encoding: .utf8)
print("cut", a[2])
