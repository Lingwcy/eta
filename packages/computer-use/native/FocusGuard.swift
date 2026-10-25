import AppKit
import ApplicationServices
import Darwin
import Foundation

// ABI facts and the theft-id lookup follow Cua Driver's key-focus guard (MIT).
// See THIRD_PARTY_NOTICES.txt. PID-scoped taps protect focus and return misdirected
// keyboard events without inspecting key contents. Unrelated apps are not keyboard-tapped.
final class WindowServerFocus: KeyFocusServer {
  typealias Connection = @convention(c) () -> UInt32
  typealias Front = @convention(c) (UnsafeMutableRawPointer) -> Int32
  typealias Key = @convention(c) (UnsafeMutableRawPointer, UnsafeMutableRawPointer) -> Int32
  typealias PID = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<pid_t>) -> Int32
  typealias Steal = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<Int32>) -> Int32
  typealias Release = @convention(c) (Int32) -> Int32
  let connection: Connection
  let front: Front
  let key: Key
  let pid: PID
  let steal: Steal
  let release: Release
  static let shared = WindowServerFocus()
  private init?() {
    _ = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL)
    let h = UnsafeMutableRawPointer(bitPattern: -2)
    guard let c = dlsym(h, "CGSMainConnectionID"), let f = dlsym(h, "_SLPSGetFrontProcess"),
      let k = dlsym(h, "SLPSGetKeyFocusProcess"), let p = dlsym(h, "GetProcessPID"),
      let s = dlsym(h, "SLPSStealKeyFocusReturningID"),
      let r = dlsym(h, "SLPSReleaseKeyFocusWithID")
    else { return nil }
    connection = unsafeBitCast(c, to: Connection.self)
    front = unsafeBitCast(f, to: Front.self)
    key = unsafeBitCast(k, to: Key.self)
    pid = unsafeBitCast(p, to: PID.self)
    steal = unsafeBitCast(s, to: Steal.self)
    release = unsafeBitCast(r, to: Release.self)
    _ = connection()
  }
  func frontPID() -> pid_t? {
    var psn: [UInt32] = [0, 0]
    var result: pid_t = 0
    guard front(&psn) == 0, pid(&psn, &result) == 0, result > 0 else { return nil }
    return result
  }
  func keyPID() -> pid_t? {
    var psn: [UInt32] = [0, 0]
    var extra: [UInt64] = [0, 0]
    var result: pid_t = 0
    guard key(&psn, &extra) == 0, pid(&psn, &result) == 0, result > 0 else { return nil }
    return result
  }
  func borrowKeyFocus() -> Int32? {
    var own: Int32 = 0
    return steal(connection(), 0xc80, &own) == 0 && own != 0 ? own : nil
  }
  func releaseKeyFocus(_ id: Int32) -> Bool { release(id) == 0 }
}

final class BackgroundFocusGuard {
  private final class RecipientContext {
    unowned let owner: BackgroundFocusGuard
    let pid: pid_t
    init(_ owner: BackgroundFocusGuard, _ pid: pid_t) {
      self.owner = owner
      self.pid = pid
    }
  }
  let front: pid_t
  let target: pid_t
  let recipients: Set<pid_t>
  private let targetWindow: UInt32
  private let events: DirectedEvents
  private let server: WindowServerFocus
  let ordering: BackgroundWindowOrdering
  private let condition = NSCondition()
  private let work = DispatchQueue(label: "eta.computer.focus-release")
  private let keyboardWork = DispatchQueue(label: "eta.computer.user-input", qos: .userInteractive)
  private var loop: CFRunLoop?
  private var ready = false
  private var stopped = false
  private var closing = false
  private var inputActive = false
  private var menuActive = false
  private var armedUntil: TimeInterval = 0
  private var lookupUntil: TimeInterval = 0
  private var orderTimer: CFRunLoopTimer?
  private var orderPending = false
  private var orderAttempts = 0
  private var problem: String?
  private static let replayMarker: Int64 = 0x4554_4146_4f43_5553
  private static let keyboardReplayMarker: Int64 = 0x4554_414b_4559_5352

  init(
    front: pid_t, target: pid_t, window: UInt32, events: DirectedEvents, server: WindowServerFocus,
    keyboardRecipient: pid_t? = nil, ordering: BackgroundWindowOrdering? = nil
  ) {
    self.front = front
    self.target = target
    let admittedRecipients = Set([target] + (keyboardRecipient.map { [$0] } ?? []))
    recipients = admittedRecipients
    targetWindow = window
    self.events = events
    self.server = server
    self.ordering =
      ordering
      ?? BackgroundWindowOrdering(
        front: front, target: target, window: window, server: server,
        temporaryKeyOwners: admittedRecipients)
  }
  func start() throws {
    guard !recipients.contains(front), !recipients.contains(getpid()),
      recipients.allSatisfy({ $0 > 0 })
    else {
      throw BridgeError("无法为键盘接收进程建立独立的后台输入保护")
    }
    guard server.frontPID() == front, server.keyPID() == front else {
      throw BridgeError("当前输入焦点属于系统面板或菜单；请先关闭后重试")
    }
    Thread.detachNewThread { [self] in
      let context = Unmanaged.passUnretained(self).toOpaque()
      let fore = CGEvent.tapCreateForPid(
        pid: front, place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: 1 << 21,
        callback: { _, type, event, context in
          guard let context else { return Unmanaged.passUnretained(event) }
          return Unmanaged<BackgroundFocusGuard>.fromOpaque(context).takeUnretainedValue()
            .foreNotice(type, event)
        }, userInfo: context)
      let keyboardMask: CGEventMask =
        (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        | (1 << CGEventType.flagsChanged.rawValue)
      let bindings = (recipients.sorted() + [getpid()]).map { RecipientContext(self, $0) }
      defer { withExtendedLifetime(bindings) {} }
      let destinations = bindings.map { binding in
        let targetMask: CGEventMask =
          binding.pid == getpid()
          ? 0
          : (1 << 21) | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
        return CGEvent.tapCreateForPid(
          pid: binding.pid, place: .headInsertEventTap, options: .defaultTap,
          eventsOfInterest: targetMask | keyboardMask,
          callback: { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let binding = Unmanaged<RecipientContext>.fromOpaque(context).takeUnretainedValue()
            return binding.owner.targetNotice(type, event, recipient: binding.pid)
          }, userInfo: Unmanaged.passUnretained(binding).toOpaque())
      }
      let ports = ([fore] + destinations).compactMap { $0 }
      let sources = ports.compactMap { CFMachPortCreateRunLoopSource(nil, $0, 0) }
      let current = CFRunLoopGetCurrent()
      condition.lock()
      let usable = ports.count == 1 + bindings.count && sources.count == ports.count && !closing
      if usable { loop = current } else if !closing { problem = "无法保护前台输入焦点；请检查辅助功能权限" }
      condition.unlock()
      if usable {
        for source in sources { CFRunLoopAddSource(current, source, .commonModes) }
        for port in ports { CGEvent.tapEnable(tap: port, enable: true) }
        let timer = CFRunLoopTimerCreateWithHandler(
          nil, Date.distantFuture.timeIntervalSinceReferenceDate, 0.05, 0, 0
        ) { [self] timer in
          condition.lock()
          let active =
            !closing && (inputActive || ProcessInfo.processInfo.systemUptime < armedUntil)
          condition.unlock()
          if active {
            queueOrderRecovery()
          } else {
            CFRunLoopTimerSetNextFireDate(timer, Date.distantFuture.timeIntervalSinceReferenceDate)
          }
        }
        condition.lock()
        orderTimer = timer
        condition.unlock()
        CFRunLoopAddTimer(current, timer, .commonModes)
      }
      condition.lock()
      ready = true
      condition.broadcast()
      let run = usable && !closing
      condition.unlock()
      if run { CFRunLoopRun() }
      condition.lock()
      let timer = orderTimer
      orderTimer = nil
      condition.unlock()
      if let timer { CFRunLoopTimerInvalidate(timer) }
      for source in sources { CFRunLoopRemoveSource(current, source, .commonModes) }
      for port in ports {
        CGEvent.tapEnable(tap: port, enable: false)
        CFMachPortInvalidate(port)
      }
      condition.lock()
      loop = nil
      stopped = true
      condition.broadcast()
      condition.unlock()
    }
    condition.lock()
    let deadline = Date().addingTimeInterval(2)
    while !ready && Date() < deadline { _ = condition.wait(until: deadline) }
    let error = problem ?? (!ready ? "前台输入保护启动超时" : nil)
    condition.unlock()
    if let error {
      _ = close()
      throw BridgeError(error)
    }
  }
  func arm() throws {
    try assertHealthy()
    guard !events.ownership.interrupted else {
      throw BridgeError("你已接管目标应用；本次任务的桌面控制已停止", reason: "user_interrupted")
    }
    condition.lock()
    let menuOpen = menuActive
    condition.unlock()
    let recovery = FocusRecovery.prepareInput(
      front: front, targets: recipients, menuOpen: menuOpen, server: server,
      allowed: recoveryAllowed)
    if case .failed(let failure) = recovery {
      fail(failure.message)
      throw BridgeError(failure.message)
    }
    guard recovery == .restored, server.frontPID() == front, server.keyPID() == front else {
      throw BridgeError("前台输入所有权已变化；请重新观察后重试")
    }
    condition.lock()
    inputActive = true
    if let orderTimer { CFRunLoopTimerSetNextFireDate(orderTimer, CFAbsoluteTimeGetCurrent()) }
    condition.unlock()
  }
  func endInput(menuOpen: Bool) {
    condition.lock()
    inputActive = false
    menuActive = menuOpen
    armedUntil = ProcessInfo.processInfo.systemUptime + 3
    condition.unlock()
  }
  func assertHealthy() throws {
    condition.lock()
    let error = problem
    condition.unlock()
    if let error { throw BridgeError(error, "unknown") }
  }
  private func fail(_ message: String) {
    condition.lock()
    problem = message
    condition.unlock()
    // If recovery is unavailable, close only this background target's menu. Never activate an app.
    if !events.ownership.interrupted && server.frontPID() == front {
      try? events.focus(target, targetWindow, false)
    }
  }
  private func queueOrderRecovery() {
    condition.lock()
    guard !closing, !orderPending else {
      condition.unlock()
      return
    }
    orderPending = true
    condition.unlock()
    work.async { [self] in
      defer {
        condition.lock()
        orderPending = false
        condition.unlock()
      }
      switch ordering.restore(allowed: recoveryAllowed) {
      case .unchanged: orderAttempts = 0
      case .superseded: break
      case .restored:
        orderAttempts += 1
        if orderAttempts > 3 { fail("无法保持前台窗口顺序；本次后台操作已停止") }
      case .failed: fail("无法保持前台窗口顺序；本次后台操作已停止")
      }
    }
  }
  private func foreNotice(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      work.async { [self] in fail("前台输入保护已失效；本次后台操作已停止") }
      return Unmanaged.passUnretained(event)
    }
    condition.lock()
    let active =
      !closing && (inputActive || menuActive || ProcessInfo.processInfo.systemUptime < armedUntil)
    condition.unlock()
    guard active, !events.ownership.interrupted,
      event.getIntegerValueField(.eventSourceUserData) != Self.replayMarker,
      type.rawValue == 21, event.getIntegerValueField(CGEventField(rawValue: 64)!) == 0x4000,
      recipients.contains(where: {
        Int64($0) == event.getIntegerValueField(CGEventField(rawValue: 73)!)
      }),
      let saved = event.copy()
    else { return Unmanaged.passUnretained(event) }
    // No WindowServer RPC inside its event callback. The serial worker validates actual ownership.
    work.async { [self] in restoreKeyFocus(saved) }
    return nil
  }
  private func targetNotice(
    _ type: CGEventType, _ event: CGEvent, recipient: pid_t
  ) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      work.async { [self] in fail("目标菜单焦点保护已失效；本次后台操作已停止") }
      return Unmanaged.passUnretained(event)
    }
    if type == .keyDown || type == .keyUp || type == .flagsChanged {
      return keyboardNotice(event, recipient: recipient)
    }
    condition.lock()
    let open = !closing
    let calibrating =
      open && !events.ownership.interrupted
      && ProcessInfo.processInfo.systemUptime < lookupUntil
    condition.unlock()
    if open && (type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown) {
      events.ownership.pointerDown(
        sourcePID: event.getIntegerValueField(.eventSourceUnixProcessID),
        marker: event.getIntegerValueField(.eventSourceUserData))
    }
    if calibrating && type.rawValue == 21,
      event.getIntegerValueField(CGEventField(rawValue: 64)!) == 0x4000,
      event.getIntegerValueField(CGEventField(rawValue: 73)!) == Int64(getpid())
    {
      return nil
    }
    return Unmanaged.passUnretained(event)
  }
  private func keyboardNotice(_ event: CGEvent, recipient: pid_t) -> Unmanaged<CGEvent>? {
    condition.lock()
    let active =
      !closing && (inputActive || menuActive || ProcessInfo.processInfo.systemUptime < armedUntil)
    condition.unlock()
    guard active, !events.ownership.interrupted,
      event.getIntegerValueField(.eventSourceUnixProcessID) != Int64(getpid()),
      event.getIntegerValueField(.eventSourceUserData) != Self.keyboardReplayMarker,
      let saved = event.copy()
    else { return Unmanaged.passUnretained(event) }
    // Never query WindowServer inside its event callback. A separate serial queue keeps
    // key-down/up/modifier order without waiting behind AX ordering recovery.
    keyboardWork.async { [self] in
      let destination = KeyboardEventRouting.destination(
        front: server.frontPID(), key: server.keyPID(), original: recipient,
        helper: getpid(), targets: recipients)
      saved.setIntegerValueField(.eventSourceUserData, value: Self.keyboardReplayMarker)
      saved.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(destination))
      saved.postToPid(destination)
    }
    return nil
  }
  private func restoreKeyFocus(_ notice: CGEvent) {
    // A human switching apps/panels owns the new focus. Replay their notice instead of undoing it.
    guard recoveryAllowed(), server.frontPID() == front, let thief = server.keyPID(),
      recipients.contains(thief)
    else {
      if server.keyPID() != front {
        notice.setIntegerValueField(.eventSourceUserData, value: Self.replayMarker)
        notice.postToPid(front)
      }
      return
    }
    condition.lock()
    lookupUntil = ProcessInfo.processInfo.systemUptime + 0.5
    condition.unlock()
    switch FocusRecovery.restore(
      front: front, target: thief, server: server, allowed: recoveryAllowed)
    {
    case .restored: queueOrderRecovery()
    case .superseded:
      if server.keyPID() != front {
        notice.setIntegerValueField(.eventSourceUserData, value: Self.replayMarker)
        notice.postToPid(front)
      }
    case .failed(let failure): fail(failure.message)
    }
  }
  private func recoveryAllowed() -> Bool {
    condition.lock()
    let open = !closing && problem == nil
    condition.unlock()
    return open && !events.ownership.interrupted
  }
  func close() -> Bool {
    condition.lock()
    closing = true
    let current = loop
    condition.unlock()
    work.sync {}
    if let current {
      CFRunLoopPerformBlock(current, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(current) }
      CFRunLoopWakeUp(current)
    }
    condition.lock()
    let deadline = Date().addingTimeInterval(2)
    while !stopped && Date() < deadline { _ = condition.wait(until: deadline) }
    let done = stopped && problem == nil
    condition.unlock()
    keyboardWork.sync {}
    return done
  }
}
