import { ApiError, install as apiInstall } from "../api";
import { clear, el } from "../dom";

type InstallFn = typeof apiInstall;

// Runs one adapter install and reports into `status`. A telemetry conflict
// (409 from claude-otel) is not a dead end: the daemon's message names the
// destination already in use, and the user can explicitly keep it (Firehose
// forwards to it) or replace it — the daemon backs the old settings up first.
export async function runAdapterInstall(
  adapter: string,
  status: HTMLElement,
  deps: { install?: InstallFn; onDone?: () => void | Promise<void> } = {},
  opts?: { replace?: boolean; forward?: boolean },
): Promise<void> {
  const doInstall = deps.install ?? apiInstall;
  status.classList.remove("error");
  clear(status);
  status.append(`installing ${adapter}…`);
  try {
    const res = await doInstall(adapter, opts);
    clear(status);
    status.append(res.detail);
    await deps.onDone?.();
  } catch (err) {
    clear(status);
    if (err instanceof ApiError && err.status === 409 && adapter === "claude-otel") {
      const forward = el("button", {}, "keep existing collector and forward to it");
      forward.addEventListener("click", () => runAdapterInstall(adapter, status, deps, { forward: true }));
      const replace = el("button", {}, "replace existing telemetry (backs up settings)");
      replace.addEventListener("click", () => runAdapterInstall(adapter, status, deps, { replace: true }));
      status.append(err.body, " ", forward, " ", replace);
    } else {
      status.append(err instanceof ApiError ? err.body : String(err));
    }
    status.classList.add("error");
  }
}
