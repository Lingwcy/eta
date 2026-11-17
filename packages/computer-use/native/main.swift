import AppKit
import ApplicationServices
import Darwin
import Foundation

// JSONL entry point; all opaque window/control state belongs to this helper lifetime.
let ownerPID = getppid()
var terminating: Int32 = 0
signal(SIGTERM) { _ in terminating = 1 }
signal(SIGINT) { _ in terminating = 1 }
func checkCancellation() throws {
  if getppid() != ownerPID { terminating = 1 }
  if terminating != 0 { throw BridgeError("桌面操作已取消", "unknown") }
}

if CommandLine.arguments.contains("--self-test") {
  print(
    "{\"protocol\":1,\"accessibility\":true,\"backgroundInput\":\((DirectedEvents().available && WindowServerFocus.shared != nil && NativeWindowIdentity.available))}"
  )
  exit(0)
}
let bridge = Bridge()
defer {
  bridge.releaseFocus()
  if bridge.cleanupFailed { exit(2) }
}
while terminating == 0, let line = readLine() {
  autoreleasepool {
    var response: [String: Any]
    do {
      guard let data = line.data(using: .utf8),
        let args = try JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { throw BridgeError("Invalid request") }
      bridge.presentationPID = args["presentationPID"] as? pid_t ?? 0
      let result: [String: Any]
      switch args["operation"] as? String {
      case "open": result = try bridge.openApplication(args)
      case "observe": result = try bridge.observe(args)
      case "wait_until": result = try bridge.waitUntil(args)
      default: result = try bridge.input(args)
      }
      response = ["ok": true, "result": result]
    } catch let error as BridgeError {
      response = ["ok": false, "message": error.message, "applied": error.applied]
      if let reason = error.reason { response["reason"] = reason }
    } catch {
      response = ["ok": false, "message": error.localizedDescription, "applied": "unknown"]
    }
    if bridge.cleanupFailed {
      let receipt = response["result"] as? [String: Any]
      response = [
        "ok": false, "message": "原生输入状态清理失败；请重启 Eta",
        "applied": receipt?["applied"] ?? response["applied"] ?? "unknown",
      ]
      terminating = 1
    }
    if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
      let text = String(data: data, encoding: .utf8)
    {
      print(text)
      fflush(stdout)
    }
  }
}
