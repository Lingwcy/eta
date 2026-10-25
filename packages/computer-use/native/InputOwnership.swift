import Foundation

// Foreign clicks invalidate the current observation, including clicks during a menu's
// temporary key-focus theft. A new observation starts a fresh interaction boundary.
final class InputOwnership {
  let pid: Int64
  let marker: Int64
  private let lock = NSLock()
  private var yielded = false

  init(pid: Int64, marker: Int64 = Int64.random(in: 1...Int64.max)) {
    self.pid = pid
    self.marker = marker
  }
  var interrupted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return yielded
  }
  // Called only after the old focus guard has drained, before reading a new frame.
  func beginObservation() {
    lock.lock()
    yielded = false
    lock.unlock()
  }
  func pointerDown(sourcePID: Int64, marker: Int64) {
    // SLPSPostEventRecordTo's key-window records arrive as mouse-downs carrying this
    // helper's source PID but no CGEvent userData. Real target taps confirmed that shape;
    // require the helper PID as well, so an untagged human/other-helper event still yields.
    if sourcePID == pid && (marker == self.marker || marker == 0) { return }
    lock.lock()
    yielded = true
    lock.unlock()
  }
}
