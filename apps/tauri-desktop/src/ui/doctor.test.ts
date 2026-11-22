// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ doctor: vi.fn(), runInstall: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), doctor: api.doctor }));

import { createDoctor } from "./doctor";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const at = "2026-11-22T12:00:00Z";
const issues = {
  gaps: [{ source: "firehose", time: at, summary: "Unreadable spool line" }],
  warnings: [{ event_id: "w1", kind: "capture_warning", source: "codex", summary: "unmapped Codex rollout record type x", time: at, observed_at: at }],
};

test("Doctor is where capture warnings and gaps are listed, each inspectable", async () => {
  api.doctor.mockResolvedValue([{ name: "spool", ok: true, detail: "writable" }]);
  const onWarning = vi.fn();
  const onGap = vi.fn();
  const p = createDoctor({ issues: () => issues, onInspectWarning: onWarning, onInspectGap: onGap });
  await p.refresh();
  await settle();
  const section = p.root.querySelector(".doctor-warnings")!;
  expect(section.querySelector("h3")!.textContent).toBe("capture warnings");
  expect(section.querySelectorAll(".capture-warning")).toHaveLength(2);
  expect(section.textContent).toContain("codex: unmapped Codex rollout record type x");
  expect(section.textContent).toContain("Unreadable spool line");
  [...section.querySelectorAll("button")].find((b) => b.textContent === "Inspect warning")!.click();
  expect(onWarning).toHaveBeenCalledWith("w1");
  [...section.querySelectorAll("button")].find((b) => b.textContent === "Inspect capture gap")!.click();
  expect(onGap).toHaveBeenCalledWith(issues.gaps[0]);
});

test("with none, Doctor says so, and redraw() picks up a new snapshot without re-running the checks", async () => {
  api.doctor.mockReset().mockResolvedValue([{ name: "spool", ok: true, detail: "writable" }]);
  let now: typeof issues = { gaps: [], warnings: [] };
  const p = createDoctor({ issues: () => now, onInspectWarning: () => {}, onInspectGap: () => {} });
  await p.refresh();
  await settle();
  expect(p.root.querySelector(".doctor-warnings")!.textContent).toContain("No capture warnings");
  now = issues;
  p.redraw();
  expect(p.root.querySelectorAll(".capture-warning")).toHaveLength(2);
  expect(api.doctor).toHaveBeenCalledTimes(1);
});
