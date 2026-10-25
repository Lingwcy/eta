import AppKit
import ApplicationServices
import Darwin
import Foundation

extension Bridge {
  func presentPointer(
    _ point: CGPoint, _ bounds: CGRect, _ pid: pid_t, _ id: UInt32, _ phase: String
  ) {
    guard presentation else { return }
    // Never paint a background Space's coordinates over the user's current content.
    // Ignore the system cursor surface; normal windows/menus above the target occlude its pointer.
    let records =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    let windows: [PointerVisibility.Window] = records.compactMap { row in
      guard let id = row[kCGWindowNumber as String] as? UInt32,
        let pid = row[kCGWindowOwnerPID as String] as? pid_t,
        let layer = row[kCGWindowLayer as String] as? Int,
        let raw = row[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: raw),
        (row[kCGWindowAlpha as String] as? Double ?? 1) > 0
      else { return nil }
      return .init(
        id: id, pid: pid, layer: layer, bounds: bounds,
        presentation: pid == presentationPID)
    }
    let visible = PointerVisibility.visible(id, pid, point, windows)
    let payload: [String: Any] = [
      "event": "pointer", "snapshot": observedSnapshot, "windowId": id,
      "point": ["x": point.x, "y": point.y], "bounds": boundsJSON(bounds), "phase": phase,
      "visible": visible,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
      let line = String(data: data, encoding: .utf8)
    {
      print(line)
      fflush(stdout)
    }
  }
}
