import Foundation

struct WindowOrderRecovery {
  struct Window {
    let id: UInt32
    let pid: pid_t
    let layer: Int
  }
  struct State {
    let front: pid_t?
    let key: pid_t?
    // The adapter compares the actual captured AX handle, not just a reusable window ID.
    let focusedWindowMatches: Bool
    let windows: [Window]
  }
  enum Outcome: Equatable { case unchanged, restored, superseded, failed }
  let front: pid_t
  let target: pid_t
  let frontWindow: UInt32
  let targetWindow: UInt32
  var temporaryKeyOwners = Set<pid_t>()

  private func owns(_ state: State) -> Bool {
    state.front == front && state.key == front && state.focusedWindowMatches
  }
  func targetIsAbove(_ windows: [Window]) -> Bool? {
    let fore = windows.indices.filter { windows[$0].id == frontWindow }
    let back = windows.indices.filter { windows[$0].id == targetWindow }
    guard fore.count == 1, back.count == 1,
      let f = fore.first, let b = back.first,
      windows[f].pid == front, windows[b].pid == target,
      windows[f].layer == 0, windows[b].layer == 0
    else { return nil }
    return b < f
  }
  // A target already above the user's window is their chosen arrangement, not ours to fix.
  func admits(_ baseline: State) -> Bool {
    owns(baseline) && targetIsAbove(baseline.windows) == false
  }

  func restore(
    allowed: () -> Bool, state: () -> State, raise: () -> Outcome
  ) -> Outcome {
    // Enumeration and AX queries can yield to user input. Recheck the original owner after
    // reading order and immediately before the mutation; no application activation fallback.
    for _ in 0..<2 {
      guard allowed() else { return .superseded }
      let current = state()
      if current.front == front, let key = current.key, temporaryKeyOwners.contains(key) {
        return .unchanged
      }
      guard owns(current), let raised = targetIsAbove(current.windows) else { return .superseded }
      if !raised { return .unchanged }
    }
    guard allowed() else { return .superseded }
    return raise()
  }
}
