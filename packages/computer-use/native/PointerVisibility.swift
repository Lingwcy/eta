import ApplicationServices
import Foundation

enum PointerVisibility {
  struct Window {
    let id: UInt32
    let pid: pid_t
    let layer: Int
    let bounds: CGRect
    let presentation: Bool
  }
  // WindowServer can publish a full-display decoration at layer 20 even though
  // the target is visible. Only interactive window/menu levels occlude the cue.
  static func visible(_ id: UInt32, _ pid: pid_t, _ point: CGPoint, _ windows: [Window]) -> Bool {
    guard windows.contains(where: { $0.id == id && $0.pid == pid }) else { return false }
    let levels: Set<Int> = [0, 3, 8, 24, 25, 101, 102, 200]
    return windows.first(where: {
      !$0.presentation && levels.contains($0.layer) && $0.bounds.contains(point)
    })?.pid == pid
  }
}
