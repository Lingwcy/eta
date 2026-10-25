import ApplicationServices
import Foundation

enum DesktopSession {
  // A locked AX server can report success while returning the application root as every
  // window. Check the session itself; NSWorkspace's cached front app can still be the old app.
  static func issue(in session: [String: Any]?) -> String? {
    guard let session else { return "无法确认桌面会话状态；请登录并解锁 macOS 后重试" }
    if session["CGSSessionScreenIsLocked"] as? Bool == true {
      return "macOS 桌面已锁定；请解锁后重新观察目标窗口"
    }
    guard session[kCGSessionOnConsoleKey as String] as? Bool == true,
      session[kCGSessionLoginDoneKey as String] as? Bool == true
    else { return "当前不是已登录的活动桌面会话；请登录并解锁 macOS 后重试" }
    return nil
  }

  static var issue: String? { issue(in: CGSessionCopyCurrentDictionary() as? [String: Any]) }
}
