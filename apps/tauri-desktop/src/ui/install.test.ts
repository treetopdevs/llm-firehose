// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";

import { ApiError } from "../api";
import { runAdapterInstall } from "./install";

const conflict = new ApiError(
  "/install/claude-otel",
  409,
  "existing Claude telemetry settings conflict: ~/.claude/settings.json already routes telemetry to http://127.0.0.1:1738/v1/logs",
);

describe("runAdapterInstall", () => {
  test("shows the daemon's detail on success", async () => {
    const status = document.createElement("p");
    const install = vi.fn().mockResolvedValue({ ok: true, detail: "hooks merged" });
    await runAdapterInstall("claude-code", status, { install });
    expect(status.textContent).toBe("hooks merged");
    expect(install).toHaveBeenCalledWith("claude-code", undefined);
  });

  test("a telemetry conflict names the existing destination and offers an explicit replace", async () => {
    const status = document.createElement("p");
    const install = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ok: true, detail: "enabled (backup: settings.json.pre-otel.bak)" });
    await runAdapterInstall("claude-otel", status, { install });
    expect(status.textContent).toContain("http://127.0.0.1:1738/v1/logs");
    expect(status.textContent).not.toContain("POST /install");
    const button = [...status.querySelectorAll("button")].find((b) => /replace/i.test(b.textContent ?? ""));
    expect(button).toBeTruthy();
    expect(install).toHaveBeenCalledTimes(1);

    button!.click();
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    expect(install).toHaveBeenLastCalledWith("claude-otel", { replace: true });
    await vi.waitFor(() => expect(status.textContent).toContain("backup"));
  });

  test("a conflict also offers to keep the existing collector by forwarding to it", async () => {
    const status = document.createElement("p");
    const install = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ok: true, detail: "enabled; your existing collector keeps receiving telemetry" });
    await runAdapterInstall("claude-otel", status, { install });
    const forward = [...status.querySelectorAll("button")].find((b) => /forward|keep/i.test(b.textContent ?? ""));
    expect(forward).toBeTruthy();

    forward!.click();
    await vi.waitFor(() => expect(install).toHaveBeenLastCalledWith("claude-otel", { forward: true }));
    await vi.waitFor(() => expect(status.textContent).toContain("existing collector"));
  });

  test("other failures are plain errors with no replace offer", async () => {
    const status = document.createElement("p");
    const install = vi.fn().mockRejectedValue(new ApiError("/install/codex", 500, "boom"));
    await runAdapterInstall("codex", status, { install });
    expect(status.textContent).toContain("boom");
    expect(status.classList.contains("error")).toBe(true);
    expect(status.querySelector("button")).toBeNull();
  });
});
