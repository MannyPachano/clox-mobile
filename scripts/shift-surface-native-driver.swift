// Test driver for scripts/shift-surface-native-check.mjs. It is compiled on a
// Mac (as main.swift, next to ShiftSurfaceModel.swift) and never ships.
// It reads a JSON array of cases on stdin and writes a JSON array of answers,
// which the check compares with the TypeScript rules for the same cases.
import Foundation

func answer(_ c: [String: Any]) -> Any {
  let op = c["op"] as? String ?? ""
  let raw = c["raw"]
  switch op {
  case "parse":
    return SurfaceState.parse(raw)?.json() ?? NSNull()
  case "view":
    let now = SurfaceJSON.number(c["nowMs"]) ?? 0
    let views = SurfaceRules.surfaceView(SurfaceState.parse(raw), nowMs: now)
    let activity: Any = views.activity?.json() ?? ["show": false]
    return ["activity": activity, "widget": views.widget.json()] as [String: Any]
  case "tapApplies":
    return SurfaceRules.tapApplies(SurfaceState.parse(raw), kind: c["kind"] as? String ?? "")
  case "applyTap":
    guard let o = raw as? [String: Any] else { return NSNull() }
    return SurfaceRules.applyTap(
      raw: o,
      id: c["id"] as? String ?? "",
      kind: c["kind"] as? String ?? "",
      tapMs: SurfaceJSON.number(c["tapMs"]) ?? 0,
      nowMs: SurfaceJSON.number(c["nowMs"]) ?? 0
    )
  case "parseView":
    return SurfaceActivityView.parse(raw)?.json() ?? NSNull()
  case "content":
    guard let view = SurfaceActivityView.parse(raw) else { return NSNull() }
    var content = ShiftActivityContent(view: view)
    if let finalText = c["finalText"] as? String { content = content.ending(with: finalText) }
    guard let data = try? JSONEncoder().encode(content),
          let object = try? JSONSerialization.jsonObject(with: data, options: [])
    else { return NSNull() }
    return object
  case "fillTime":
    return SurfaceRules.fillTime(c["template"] as? String ?? "", c["time"] as? String) ?? NSNull()
  case "sameShift":
    return SurfaceRules.sameShift(SurfaceJSON.number(c["a"]), SurfaceJSON.number(c["b"]))
  default:
    return NSNull()
  }
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let cases = (try? JSONSerialization.jsonObject(with: input, options: [])) as? [Any] else {
  FileHandle.standardError.write("The driver expects a JSON array of cases.\n".data(using: .utf8)!)
  exit(2)
}
let answers: [Any] = cases.map { item in
  guard let c = item as? [String: Any] else { return NSNull() }
  return answer(c)
}
let output = try JSONSerialization.data(withJSONObject: answers, options: [])
FileHandle.standardOutput.write(output)
