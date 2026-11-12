import AppKit
import ApplicationServices
import Darwin
import Foundation

final class Bridge {
  let events = DirectedEvents()
  var presentation = false
  var presentationPID: pid_t = 0
  init() {
    events.pointer = { [weak self] point, bounds, pid, id, phase in
      self?.presentPointer(point, bounds, pid, id, phase)
    }
  }
  var menuBarTarget: MenuBarTarget?
  var windowID: UInt32 = 0
  var cursor: CGPoint?
  var cleanupFailed = false
  var syntheticTarget: (pid: pid_t, windowID: UInt32)?
  var focusGuard: BackgroundFocusGuard?
  var snapshot = ""
  var observedSnapshot = ""
  var application: NSRunningApplication?
  var window: AXUIElement?
  var regionRoot: AXUIElement?
  var indexed: [AXUIElement] = []
  var visibleIndexes = Set<Int>()
}
