// Compiled as an .app because UNUserNotificationCenter refuses a bare command line
// tool: the notification is credited to a bundle identity, so `Bundle.main` must
// resolve to this .app.

import Foundation
import UserNotifications

// A backstop under the caller's own timeout, generous because the first run waits for a
// human to answer the permission dialog.
let TIMEOUT_SECONDS = 90.0

enum Exit: Int32 {
  case delivered = 0
  case notAuthorized = 1
  case failed = 2
  case timedOut = 3
  case badUsage = 64
}

// A clean exit does not mean the banner was shown, so the caller gets the grant state.
func emit(_ fields: [String: String]) {
  let line = fields.keys.sorted().map { "\($0)=\(fields[$0] ?? "")" }.joined(separator: " ")
  print(line)
}

func statusName(_ status: UNAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined"
  case .denied: return "denied"
  case .authorized: return "authorized"
  case .provisional: return "provisional"
  case .ephemeral: return "ephemeral"
  @unknown default: return "unknown"
  }
}

func finish(_ code: Exit) -> Never {
  exit(code.rawValue)
}

// Unrecognised flags are ignored rather than fatal, so a newer server cannot break
// an older installed helper.
func option(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let center = UNUserNotificationCenter.current()
let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""

// An unanswered authorization dialog would otherwise hold the process open for as
// long as it stays on screen.
DispatchQueue.main.asyncAfter(deadline: .now() + TIMEOUT_SECONDS) {
  emit(["result": "timeout"])
  finish(.timedOut)
}

switch command {
case "status":
  center.getNotificationSettings { settings in
    emit(["result": "ok", "authorization": statusName(settings.authorizationStatus)])
    finish(settings.authorizationStatus == .authorized ? .delivered : .notAuthorized)
  }

case "post":
  guard let body = option("body") else {
    emit(["result": "usage", "detail": "post needs --body"])
    finish(.badUsage)
  }
  center.requestAuthorization(options: [.alert, .sound]) { _, _ in
    let content = UNMutableNotificationContent()
    content.title = option("title") ?? "Gatekeeper"
    if let subtitle = option("subtitle"), !subtitle.isEmpty {
      content.subtitle = subtitle
    }
    content.body = body
    let request = UNNotificationRequest(
      identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(request) { error in
      // A denied app accepts the request and delivers nothing, so read the grant
      // back instead of trusting the add.
      center.getNotificationSettings { settings in
        let authorization = statusName(settings.authorizationStatus)
        if let error = error {
          emit([
            "result": "error", "authorization": authorization,
            "detail": error.localizedDescription,
          ])
          finish(.failed)
        }
        emit(["result": "ok", "authorization": authorization])
        finish(settings.authorizationStatus == .authorized ? .delivered : .notAuthorized)
      }
    }
  }

default:
  emit(["result": "usage", "detail": "expected `post --body <text>` or `status`"])
  finish(.badUsage)
}

CFRunLoopRun()
