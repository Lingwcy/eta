import ApplicationServices
import Darwin
import Foundation

enum NativeWindowIdentity {
  struct Record {
    let id: UInt32
    let pid: pid_t
    let layer: Int
    let bounds: CGRect
  }
  typealias Lookup = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> Int32
  private static let lookup = dlsym(
    UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow"
  )
  .map { unsafeBitCast($0, to: Lookup.self) }
  static var available: Bool { lookup != nil }
  static func windowID(_ element: AXUIElement) -> UInt32? {
    var id: UInt32 = 0
    guard let lookup, lookup(element, &id) == 0, id != 0 else { return nil }
    return id
  }
  enum Surface {
    case window, transient, menuBar
    func allows(_ layer: Int) -> Bool {
      switch self {
      case .window: return layer == 0
      case .transient: return [0, 3, 8, 25, 101].contains(layer)
      case .menuBar: return layer == 24
      }
    }
  }
  // Geometry confirms a live identity; it never chooses an identity. Equal-sized, overlapping
  // windows are common, and a stale AX window must not bind to its replacement at the same bounds.
  static func resolve(axID: UInt32?, pid: pid_t, bounds: CGRect, windows: [Record], surface: Surface = .window) -> UInt32? {
    guard let axID, axID != 0 else { return nil }
    let matching = windows.filter { $0.id == axID }
    guard matching.count == 1, let window = matching.first,
      window.pid == pid, surface.allows(window.layer),
      abs(window.bounds.minX - bounds.minX) < 2,
      abs(window.bounds.minY - bounds.minY) < 2,
      abs(window.bounds.width - bounds.width) < 2,
      (abs(window.bounds.height - bounds.height) < 2
        || (surface == .transient && window.bounds.contains(bounds)
          && window.bounds.height - bounds.height <= 16))
    else { return nil }
    return axID
  }

  // ViewBridge can publish a host-PID AX proxy for a remote process's native window.
  // KeyboardScope must independently admit this element through the observed focus graph.
  static func keyboardRecipient(axPID: pid_t, axWindowID: UInt32?, windows: [Record]) -> pid_t? {
    guard axPID > 0 else { return nil }
    guard let axWindowID else { return axPID }
    let matches = windows.filter { $0.id == axWindowID }
    guard matches.count == 1, let window = matches.first, window.pid > 0, Surface.transient.allows(window.layer)
    else { return nil }
    return window.pid
  }
}
