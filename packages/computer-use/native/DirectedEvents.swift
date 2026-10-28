import AppKit
import ApplicationServices
import Darwin
import Foundation

// These SPIs stay behind one adapter. Missing symbols fail before input; there is no HID fallback.
final class DirectedEvents {
  let ownership = InputOwnership(pid: Int64(getpid()))
  func mark(_ event: CGEvent) {
    event.setIntegerValueField(.eventSourceUserData, value: ownership.marker)
  }
  typealias Post = @convention(c) (pid_t, CGEvent) -> Void
  typealias WindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  typealias ProcessLookup = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
  typealias Record = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
  var pointer: ((CGPoint, CGRect, pid_t, UInt32, String) -> Void)?
  let source = CGEventSource(stateID: .privateState)!
  let post: Post?
  let location: WindowLocation?
  let lookup: ProcessLookup?
  let record: Record?
  init() {
    _ = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
    let handle = UnsafeMutableRawPointer(bitPattern: -2)
    // SLPS needs the calling process to own a WindowServer connection, even for PID-scoped records.
    typealias Connection = @convention(c) () -> UInt32
    if let initialize = dlsym(handle, "CGSMainConnectionID") {
      _ = unsafeBitCast(initialize, to: Connection.self)()
    }
    post = dlsym(handle, "SLEventPostToPid").map { unsafeBitCast($0, to: Post.self) }
    location = dlsym(handle, "CGEventSetWindowLocation").map {
      unsafeBitCast($0, to: WindowLocation.self)
    }
    lookup = dlsym(handle, "GetProcessForPID").map { unsafeBitCast($0, to: ProcessLookup.self) }
    record = dlsym(handle, "SLPSPostEventRecordTo").map { unsafeBitCast($0, to: Record.self) }
  }
  var available: Bool { post != nil && location != nil && lookup != nil && record != nil }
  func focus(_ pid: pid_t, _ windowID: UInt32, _ active: Bool) throws {
    guard let lookup, let record else { throw BridgeError("当前 macOS 不支持后台定向输入") }
    var psn: [UInt32] = [0, 0]
    guard lookup(pid, &psn) == 0 else { throw BridgeError("目标进程已失效") }
    var bytes = [UInt8](repeating: 0, count: 0xf8)
    bytes[4] = 0xf8
    bytes[8] = 0x0d
    bytes[0x8a] = active ? 1 : 2
    var id = windowID.littleEndian
    withUnsafeBytes(of: &id) { bytes.replaceSubrange(0x3c..<0x40, with: $0) }
    guard record(&psn, &bytes) == 0 else { throw BridgeError("无法准备目标窗口的后台输入", "unknown") }
  }
  // Event-record layout derived from yabai; see THIRD_PARTY_NOTICES.txt.
  func keyWindow(_ pid: pid_t, _ windowID: UInt32) throws {
    guard let lookup, let record else { throw BridgeError("后台窗口输入接口不可用") }
    var psn: [UInt32] = [0, 0]
    guard lookup(pid, &psn) == 0 else { throw BridgeError("目标进程已失效") }
    var bytes = [UInt8](repeating: 0, count: 0xf8)
    bytes[4] = 0xf8
    bytes[0x3a] = 0x10
    var id = windowID.littleEndian
    var offscreen = -1_000_000.0
    withUnsafeBytes(of: &id) { bytes.replaceSubrange(0x3c..<0x40, with: $0) }
    withUnsafeBytes(of: &offscreen) {
      bytes.replaceSubrange(0x20..<0x28, with: $0)
      bytes.replaceSubrange(0x28..<0x30, with: $0)
    }
    for kind: UInt8 in [1, 2] {
      bytes[8] = kind
      guard record(&psn, &bytes) == 0 else { throw BridgeError("无法准备后台目标窗口", "unknown") }
    }
  }
  func mouse(
    _ type: NSEvent.EventType, _ point: CGPoint, _ bounds: CGRect, _ pid: pid_t, _ windowID: UInt32,
    _ count: Int = 1
  ) throws {
    guard let location else { throw BridgeError("当前 macOS 不支持后台坐标输入") }
    // NSEvent's bridge carries the window number. Its y axis is relative to the primary screen;
    // CGEventSetWindowLocation stamps the target-window top-left coordinates separately.
    let height = NSScreen.screens.first?.frame.height ?? 0
    let local = CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY)
    guard
      let ns = NSEvent.mouseEvent(
        with: type, location: NSPoint(x: local.x, y: height - local.y), modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(windowID), context: nil,
        eventNumber: 0, clickCount: count,
        pressure: type == .leftMouseUp || type == .rightMouseUp ? 0 : 1), let event = ns.cgEvent
    else { throw BridgeError("无法创建定向鼠标事件") }
    event.setSource(source)
    event.location = point
    location(event, local)
    event.flags = []
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
    event.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(
      .mouseEventButtonNumber, value: type == .rightMouseDown || type == .rightMouseUp ? 1 : 0)
    mark(event)
    event.postToPid(pid)
    let phase =
      type == .leftMouseDown || type == .rightMouseDown
      ? "down" : type == .leftMouseUp || type == .rightMouseUp ? "up" : "move"
    pointer?(point, bounds, pid, windowID, phase)
  }
  func keyboard(
    _ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags, _ pid: pid_t, _ text: String? = nil
  ) throws {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw BridgeError("无法创建定向键盘事件")
    }
    event.flags = flags
    if let text {
      let units = Array(text.utf16)
      units.withUnsafeBufferPointer {
        event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
      }
    }
    mark(event)
    event.postToPid(pid)
  }
  func scroll(
    _ point: CGPoint, _ bounds: CGRect, _ dx: Int32, _ dy: Int32, _ pid: pid_t, _ windowID: UInt32
  ) throws {
    guard let post, let location else { throw BridgeError("当前 macOS 不支持后台滚动") }
    try mouse(.mouseMoved, point, bounds, pid, windowID)
    RunLoop.current.run(until: Date().addingTimeInterval(0.012))
    guard
      let event = CGEvent(
        scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx,
        wheel3: 0)
    else { throw BridgeError("无法创建滚动事件") }
    event.location = point
    event.flags = []
    location(event, CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY))
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
    event.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(windowID))
    mark(event)
    post(pid, event)
  }
}
