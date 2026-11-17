import Foundation

enum TargetSelection {
  struct Application {
    let pid: Int32
    let name: String
    let bundleIdentifier: String?
    let path: String?
    let regular: Bool
  }

  static func applications(
    _ name: String, in applications: [Application], installedPath: () -> String?
  ) -> [Int] {
    if name.hasPrefix("pid:") {
      guard let pid = Int32(name.dropFirst(4)), pid > 0 else { return [] }
      return applications.indices.filter { applications[$0].pid == pid }
    }
    let exact = applications.indices.filter {
      let app = applications[$0]
      return app.bundleIdentifier == name || app.path == name
        || app.name.compare(name, options: .caseInsensitive) == .orderedSame
    }
    if !exact.isEmpty { return exact }
    // Resolve the same installed bundle as open before accepting a substring such
    // as SJMCL for MCL. A localized process name need not match its .app filename.
    if let path = installedPath() {
      return applications.indices.filter { applications[$0].path == path }
    }
    return applicationAliases(name, in: applications.map { ($0.name, $0.regular) })
  }

  static func applicationAliases(
    _ name: String, in applications: [(name: String, regular: Bool)]
  ) -> [Int] {
    // Accessory processes can include browser capture helpers with similar names.
    // They remain selectable by an exact name, bundle ID or PID in the caller.
    let exact = applications.indices.filter {
      applications[$0].name.compare(name, options: .caseInsensitive) == .orderedSame
    }
    if !exact.isEmpty { return exact }
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
