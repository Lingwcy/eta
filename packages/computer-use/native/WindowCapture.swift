import AppKit
import ApplicationServices
import Darwin
import Foundation
import ScreenCaptureKit

// ScreenCaptureKit callbacks may run on arbitrary queues; protect completion and keep AppKit's run loop alive.
func completed<T>(_ start: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
  let lock = NSLock()
  var result: Result<T, Error>?
  start { value in
    lock.lock()
    result = value
    lock.unlock()
  }
  let deadline = Date().addingTimeInterval(8)
  while Date() < deadline {
    try checkCancellation()
    lock.lock()
    let value = result
    lock.unlock()
    if let value { return try value.get() }
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
  }
  throw BridgeError("窗口截图超时")
}

extension Bridge {
  func layout(_ args: [String: Any]) throws -> [String: Any] {
    guard let app = application, let window,
      try identifyWindow(app.processIdentifier, window) == windowID
    else { throw BridgeError("目标窗口身份已变化；请重新 observe") }
    let bounds = boundsJSON(try rect(window))
    let revision = String(
      data: try JSONSerialization.data(withJSONObject: bounds, options: [.sortedKeys]),
      encoding: .utf8)!
    return ["id": "window:\(windowID)", "revision": revision, "bounds": bounds]
  }
  func capture(_ args: [String: Any]) throws -> [String: Any] {
    if let issue = DesktopSession.issue { throw BridgeError(issue) }
    guard #available(macOS 14.0, *) else { throw BridgeError("窗口级截图需要 macOS 14 或更新版本") }
    let before = try layout(args)
    guard CGPreflightScreenCaptureAccess() else { throw BridgeError("请先允许屏幕录制") }
    let content: SCShareableContent = try completed { done in
      SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) {
        value, error in
        if let value {
          done(.success(value))
        } else {
          done(.failure(error ?? BridgeError("无法枚举可截图窗口")))
        }
      }
    }
    guard let target = content.windows.first(where: { $0.windowID == windowID }), let window else {
      throw BridgeError("目标窗口无法截图；请确认窗口未最小化")
    }
    // ScreenCaptureKit fails with -3811 for off-Space menus, even when capturing
    // their native window separately. Keep the base image usable and disclose its
    // scope; the AX tree still exposes numbered menu actions without switching Space.
    var excludesChildWindows = false
    if #available(macOS 14.2, *), !target.isOnScreen { excludesChildWindows = true }
    let r = try rect(window)
    let limits = args["limits"] as? [String: Any] ?? [:]
    let scale = min(
      1.0, 1280 / max(r.width, r.height), (limits["maxWidth"] as? Double ?? 1280) / r.width,
      (limits["maxHeight"] as? Double ?? 1280) / r.height)
    guard scale > 0, scale.isFinite else { throw BridgeError("截图尺寸限制无效") }
    let outputWidth = max(1, Int(r.width * scale))
    let outputHeight = max(1, Int(r.height * scale))
    guard
      let canvas = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: outputWidth, pixelsHigh: outputHeight, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0), let drawing = NSGraphicsContext(bitmapImageRep: canvas)
    else { throw BridgeError("无法创建窗口截图") }
    drawing.cgContext.clear(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
    let pieces = content.displays.compactMap { display -> (SCDisplay, CGRect)? in
      let piece = r.intersection(display.frame)
      return piece.isNull || piece.isEmpty ? nil : (display, piece)
    }
    guard !pieces.isEmpty else { throw BridgeError("目标窗口不在可捕获的显示区域") }
    // A display-bound window filter has a stable display coordinate system even when
    // menus appear. It includes only this window and its children, never the desktop.
    // Stitch intersections so a window spanning displays retains one pixel-to-window map.
    for (display, piece) in pieces {
      try checkCancellation()
      let destination = CGRect(
        x: (piece.minX - r.minX) * Double(outputWidth) / r.width,
        y: Double(outputHeight) - (piece.maxY - r.minY) * Double(outputHeight) / r.height,
        width: piece.width * Double(outputWidth) / r.width,
        height: piece.height * Double(outputHeight) / r.height)
      let config = SCStreamConfiguration()
      config.width = max(1, Int(destination.width.rounded()))
      config.height = max(1, Int(destination.height.rounded()))
      config.showsCursor = false
      if #available(macOS 14.2, *) { config.includeChildWindows = !excludesChildWindows }
      config.ignoreShadowsDisplay = true
      config.sourceRect = piece.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
      config.destinationRect = CGRect(x: 0, y: 0, width: config.width, height: config.height)
      config.preservesAspectRatio = false
      let image: CGImage = try completed { done in
        SCScreenshotManager.captureImage(
          contentFilter: SCContentFilter(display: display, including: [target]),
          configuration: config
        ) { image, error in
          if let image {
            done(.success(image))
          } else {
            done(.failure(error ?? BridgeError("窗口截图失败")))
          }
        }
      }
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = drawing
      NSImage(cgImage: image, size: NSSize(width: config.width, height: config.height)).draw(
        in: destination, from: .zero, operation: .copy, fraction: 1)
      NSGraphicsContext.restoreGraphicsState()
    }
    guard let image = canvas.cgImage else { throw BridgeError("窗口截图为空") }
    let after = try layout(args)
    guard NSDictionary(dictionary: before).isEqual(to: after) else {
      throw BridgeError("截图时窗口位置发生变化；请重新观察")
    }
    // The agent cursor is painted only into its observation. The physical cursor never participates.
    let bitmap = NSBitmapImageRep(cgImage: image)
    if limits["includeCursor"] as? Bool != false, let cursor,
      let context = NSGraphicsContext(bitmapImageRep: bitmap)
    {
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = context
      let x = cursor.x * Double(image.width) / r.width
      let y = Double(image.height) - cursor.y * Double(image.height) / r.height
      let arrow = NSBezierPath()
      arrow.move(to: NSPoint(x: x, y: y))
      arrow.line(to: NSPoint(x: x + 4, y: y - 18))
      arrow.line(to: NSPoint(x: x + 8, y: y - 12))
      arrow.line(to: NSPoint(x: x + 15, y: y - 10))
      arrow.close()
      NSColor.systemPurple.setFill()
      arrow.fill()
      NSColor.white.setStroke()
      arrow.lineWidth = 1
      arrow.stroke()
      NSGraphicsContext.restoreGraphicsState()
    }
    let budget = min(3_000_000, limits["maxBytes"] as? Int ?? 3_000_000)
    var data = bitmap.representation(using: .png, properties: [:])!
    var mime = "image/png"
    var width = image.width
    var height = image.height
    var encoded = data.base64EncodedString()
    for attempt in 0..<5 where encoded.count > budget {
      width = attempt == 0 ? width : max(1, width / 2)
      height = attempt == 0 ? height : max(1, height / 2)
      let resized = NSImage(size: NSSize(width: width, height: height))
      resized.lockFocus()
      NSImage(cgImage: bitmap.cgImage!, size: NSSize(width: image.width, height: image.height))
        .draw(in: NSRect(x: 0, y: 0, width: width, height: height))
      resized.unlockFocus()
      guard let tiff = resized.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let jpeg = rep.representation(
          using: .jpeg,
          properties: [
            .compressionFactor: Double(min(80, limits["jpegQuality"] as? Int ?? 80)) / 100.0
          ])
      else { throw BridgeError("无法编码窗口截图") }
      data = jpeg
      mime = "image/jpeg"
      encoded = data.base64EncodedString()
    }
    guard encoded.count <= budget else { throw BridgeError("截图无法满足模型图片大小限制") }
    return [
      "layout": before, "width": width, "height": height,
      "excludesChildWindows": excludesChildWindows,
      "image": ["type": "image", "data": encoded, "mimeType": mime],
    ]
  }
}
