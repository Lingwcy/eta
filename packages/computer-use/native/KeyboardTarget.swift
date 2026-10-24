import Foundation

enum ForegroundWindowAdmission {
  // PID-directed input cannot isolate two windows of the foreground app: selecting the
  // observed window also redirects the user's keyboard. Refuse before focus or input changes.
  static func allows<Node>(
    front: pid_t, target: pid_t, observed: Node, focused: Node?, equal: (Node, Node) -> Bool
  ) -> Bool {
    if front != target { return true }
    return focused.map { equal($0, observed) } ?? false
  }
}

// AX can expose hosted controls from a different process. The recipient is admitted only
// through the observed window's focus graph, never through the global focused application.
struct KeyboardTarget<Node> {
  let pid: pid_t
  let element: Node?
}

struct KeyboardScope<Node> {
  let equal: (Node, Node) -> Bool
  let sameWindow: (Node, Node) -> Bool
  let process: (Node) -> pid_t?
  let enclosingWindow: (Node) -> Node?
  let parent: (Node) -> Node?

  private func inside(_ node: Node, _ ancestor: Node) -> Bool {
    var current: Node? = node
    for _ in 0..<32 {
      guard let value = current else { return false }
      if equal(value, ancestor) { return true }
      current = parent(value)
    }
    return false
  }

  func resolve(
    app: pid_t, window: Node, focusedWindow: Node?, focusedElement: Node?, requested: Node? = nil
  ) -> KeyboardTarget<Node>? {
    guard let focusedWindow, sameWindow(focusedWindow, window) else { return nil }
    guard let focusedElement else {
      // App-level shortcuts and canvas input may have no AX focused control.
      return requested == nil ? KeyboardTarget(pid: app, element: nil) : nil
    }
    guard let pid = process(focusedElement), pid > 0 else { return nil }
    if let enclosing = enclosingWindow(focusedElement) {
      if !sameWindow(enclosing, window) {
        // A focused sheet can report its host as AXWindow. Its focused control must
        // still have an actual parent path through the observed sheet.
        guard let host = enclosingWindow(window), sameWindow(enclosing, host),
          inside(focusedElement, window)
        else { return nil }
      }
    } else {
      guard inside(focusedElement, window) else { return nil }
    }
    if let requested, !inside(focusedElement, requested) { return nil }
    return KeyboardTarget(pid: pid, element: focusedElement)
  }

  func unchanged(_ original: KeyboardTarget<Node>, _ current: KeyboardTarget<Node>) -> Bool {
    guard original.pid == current.pid else { return false }
    switch (original.element, current.element) {
    case (nil, nil): return true
    case (.some(let original), .some(let current)): return equal(original, current)
    default: return false
    }
  }
}
