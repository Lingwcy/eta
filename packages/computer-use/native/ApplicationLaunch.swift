import AppKit
import Foundation

// NSWorkspace publishes running-application changes on the main run loop. The JSONL
// reader blocks between requests, so drain notifications before consulting its cache.
func runningApplications() -> [NSRunningApplication] {
  RunLoop.current.run(until: Date().addingTimeInterval(0.01))
  return NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }
}

func installedApplicationURL(_ name: String) -> URL? {
  let workspace = NSWorkspace.shared
  if let url = workspace.urlForApplication(withBundleIdentifier: name) { return url }
  // The replacement API accepts bundle IDs only; keep Launch Services name/path lookup too.
  return workspace.fullPath(forApplication: name).map { URL(fileURLWithPath: $0) }
}

// The launch callback can outlive cancellation. It owns only this receipt, never
// Bridge state or a later observation; completion is read on the request's owner.
private final class LaunchCompletion: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<NSRunningApplication, Error>?
  func finish(_ app: NSRunningApplication?, _ error: Error?) {
    lock.lock()
    defer { lock.unlock() }
    if let app { result = .success(app) }
    else { result = .failure(error ?? BridgeError("启动没有返回应用实例", "unknown")) }
  }
  func read() -> Result<NSRunningApplication, Error>? {
    lock.lock()
    defer { lock.unlock() }
    return result
  }
}

extension Bridge {
  func openApplication(_ args: [String: Any]) throws -> [String: Any] {
    try checkCancellation()
    try assertOwnership()
    if let issue = DesktopSession.issue { throw BridgeError(issue) }
    guard let name = args["app"] as? String, !name.isEmpty, !name.hasPrefix("pid:") else {
      throw BridgeError("open requires an application name or bundle identifier")
    }
    guard let url = installedApplicationURL(name) else {
      throw BridgeError("未找到已安装应用 \(quoted(name))；请确认应用名称、bundle ID 或 .app 路径")
    }
    releaseFocus()
    guard !cleanupFailed else { throw BridgeError("无法清理旧输入；请重启 Eta", "unknown") }
    snapshot = ""
    observedSnapshot = ""
    indexed = []
    visibleIndexes = []
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    let completion = LaunchCompletion()
    try checkCancellation()
    try assertOwnership()
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
      completion.finish(app, error)
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 15
    while true {
      try checkCancellation()
      try assertOwnership("unknown")
      if let result = completion.read() {
        let app: NSRunningApplication
        do { app = try result.get() }
        catch { throw BridgeError("启动失败：\(error.localizedDescription)", "unknown") }
        guard !app.isTerminated else {
          throw BridgeError("应用启动后已退出；请检查应用启动错误", "yes")
        }
        return ["app": "pid:\(app.processIdentifier)"]
      }
      guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw BridgeError("启动请求已发送，但未能确认应用实例；请先检查当前状态，不要直接重复启动", "unknown")
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
  }
}
