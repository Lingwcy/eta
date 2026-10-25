import Foundation

enum TargetSelection {
  static func applicationAliases(
    _ name: String, in applications: [(name: String, regular: Bool)]
  ) -> [Int] {
    // Accessory processes can include browser capture helpers with similar names.
    // They remain selectable by an exact name, bundle ID or PID in the caller.
    let regular = applications.indices.filter { applications[$0].regular }
    return matching(name, in: regular.map { applications[$0].name }).map { regular[$0] }
  }

  // App decorations (for example Chrome's Incognito suffix) are often omitted by a user.
  // Exact titles win; a partial title is usable only when it identifies a single window.
  static func matching(_ title: String, in titles: [String]) -> [Int] {
    guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
    let exact = titles.indices.filter { titles[$0] == title }
    if !exact.isEmpty { return exact }
    return titles.indices.filter { titles[$0].localizedCaseInsensitiveContains(title) }
  }
}
