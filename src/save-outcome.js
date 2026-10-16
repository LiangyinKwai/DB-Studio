/**
 * Keep native and browser save flows explicit. A native save dialog returning
 * false means the user cancelled; it must never fall through to a browser
 * download or be reported as a successful save.
 */
export function resolveSaveOutcome(nativeAvailable, nativeResult) {
  if (!nativeAvailable) return "download";
  return nativeResult === true ? "saved" : "cancelled";
}
