import Foundation

enum PublishedWindows {
  // AXWindows can contain only the current Space. AppKit still publishes its focused
  // and main window through independent attributes; include them without activating it.
  // Callers must validate role, process and native window ID before admitting a candidate.
  static func merge<Node>(
    listed: [Node], focused: Node?, main: Node?, equal: (Node, Node) -> Bool
  ) -> [Node] {
    var result = listed
    for candidate in [focused, main].compactMap({ $0 }) {
      if !result.contains(where: { equal($0, candidate) }) { result.append(candidate) }
    }
    return result
  }
}
