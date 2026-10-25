import AppKit
import ApplicationServices
import Foundation

// AppKit menu tracking can raise the target's whole window group without changing the
// front process. Preserve only the already-focused foreground window, never activate it.
final class BackgroundWindowOrdering {
  private let front: pid_t
  private let server: WindowServerFocus
  private let root: AXUIElement
  private let focused: AXUIElement?
  private var recovery: WindowOrderRecovery?

  init(
    front: pid_t, target: pid_t, window: UInt32, server: WindowServerFocus,
    temporaryKeyOwners: Set<pid_t>
  ) {
    self.front = front
    self.server = server
    root = AXUIElementCreateApplication(front)
    AXUIElementSetMessagingTimeout(root, 0.2)
    focused = axNode(root, kAXFocusedWindowAttribute)
    if let focused, let id = NativeWindowIdentity.windowID(focused) {
      var candidate = WindowOrderRecovery(
        front: front, target: target, frontWindow: id, targetWindow: window)
      candidate.temporaryKeyOwners = temporaryKeyOwners
      recovery = candidate
    } else {
      recovery = nil
    }
    if let recovery, !recovery.admits(state()) { admitted = false }
  }
  private var admitted = true
  // Called only after the previous guard drains and before the replacement is armed.
  func admitKeyboardRecipient(_ pid: pid_t) { recovery?.temporaryKeyOwners.insert(pid) }
  func foregroundWindowMatches() -> Bool { focusMatches() }
  private func focusMatches() -> Bool {
    guard let focused, let current = axNode(root, kAXFocusedWindowAttribute),
      CFEqual(current, focused), validWindowSurface(current, front)
    else { return false }
    var pid: pid_t = 0
    return AXUIElementGetPid(current, &pid) == .success && pid == front
  }
  private func windows() -> [WindowOrderRecovery.Window] {
    let records =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    return records.compactMap { record in
      guard let id = record[kCGWindowNumber as String] as? UInt32,
        let pid = record[kCGWindowOwnerPID as String] as? pid_t,
        let layer = record[kCGWindowLayer as String] as? Int
      else { return nil }
      return .init(id: id, pid: pid, layer: layer)
    }
  }
  private func state() -> WindowOrderRecovery.State {
    let records = windows()
    let matches = focusMatches()
    return .init(
      front: server.frontPID(), key: server.keyPID(), focusedWindowMatches: matches,
      windows: records)
  }
  func restore(allowed: () -> Bool) -> WindowOrderRecovery.Outcome {
    guard allowed() else { return .superseded }
    guard admitted, let recovery, let focused else { return .unchanged }
    guard server.frontPID() == front,
      let raised = recovery.targetIsAbove(windows())
    else {
      admitted = false
      return .superseded
    }
    // Most samples need no correction. Avoid AX RPCs to the user's app on that path.
    if !raised { return .unchanged }
    let outcome = recovery.restore(allowed: allowed, state: state) {
      guard allowed(), server.frontPID() == front, server.keyPID() == front, focusMatches()
      else { return .superseded }
      return AXUIElementPerformAction(focused, kAXRaiseAction as CFString) == .success
        ? .restored : .failed
    }
    if outcome == .superseded, allowed() { admitted = false }
    return outcome
  }
}
