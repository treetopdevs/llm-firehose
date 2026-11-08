// Failure copy for panels: what could not be done, why, and what happens next.
// The status bar's connection loop retries on its own, so "unreachable" points there.

/** The wording each engine uses when fetch cannot reach the host (WebKit is the Tauri webview on macOS). */
const UNREACHABLE = /failed to fetch|load failed|networkerror/i;

const sentence = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** A sentence for the user. `action` completes "Couldn't …", e.g. "load sessions". */
export function failureMessage(action: string, err: unknown): string {
  const lead = `Couldn't ${action}`;
  // By name, not instanceof: panel tests mock the api module.
  const api = err as { name?: string; status?: number; body?: string };
  if (api?.name === "ApiError") {
    const body = sentence(api.body ?? "");
    return `${lead}: the engine answered ${api.status}${body ? ` (${body})` : ""}.`;
  }
  if (err instanceof TypeError && UNREACHABLE.test(err.message)) {
    return `${lead}: the local engine (firehosed) isn't responding. The app keeps retrying; reopen this view when the status bar says LIVE.`;
  }
  return `${lead}: ${sentence(err instanceof Error ? err.message : String(err))}.`;
}
