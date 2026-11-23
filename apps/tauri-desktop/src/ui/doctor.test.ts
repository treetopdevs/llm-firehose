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

test("capture diagnostics stay listed while the checks load and after they fail, and redraw() still reaches them", async () => {
  let release!: () => void;
  api.doctor.mockReset().mockImplementation(() => new Promise((_ok, no) => { release = () => no(new Error("daemon down")); }));
  let now: typeof issues = { gaps: [], warnings: [] };
  const p = createDoctor({ issues: () => now, onInspectWarning: () => {}, onInspectGap: () => {} });
  const loading = p.refresh();
  expect(p.root.querySelector(".doctor-warnings")).not.toBeNull();
  release();
  await loading;
  await settle();
  expect(p.root.querySelector(".error")).not.toBeNull();
  expect(p.root.querySelector(".doctor-warnings")).not.toBeNull();
  now = issues;
  p.redraw();
  expect(p.root.querySelectorAll(".doctor-warnings .capture-warning")).toHaveLength(2);
});

test("a warning whose evidence cannot be inspected says so inside Doctor", async () => {
  api.doctor.mockReset().mockResolvedValue([{ name: "spool", ok: true, detail: "writable" }]);
  const p = createDoctor({ issues: () => issues, onInspectWarning: async () => false, onInspectGap: () => {} });
  await p.refresh();
  await settle();
  [...p.root.querySelectorAll("button")].find((b) => b.textContent === "Inspect warning")!.click();
  await settle();
  const msg = p.root.querySelector(".doctor-warnings [role=status]")!;
  expect(p.root.contains(msg)).toBe(true);
  expect(msg.textContent).toContain("unavailable");
  p.redraw();
  expect(p.root.querySelector(".doctor-warnings [role=status]")!.textContent).toContain("unavailable");
});

const warnBtn = (p: ReturnType<typeof createDoctor>) => [...p.root.querySelectorAll("button")].find((b) => b.textContent === "Inspect warning")!;
const gapBtn = (p: ReturnType<typeof createDoctor>) => [...p.root.querySelectorAll("button")].find((b) => b.textContent === "Inspect capture gap")!;
const statusOf = (p: ReturnType<typeof createDoctor>) => p.root.querySelector<HTMLElement>(".doctor-warnings [role=status]")!;

test("a warning inspection that was superseded is not reported as unavailable evidence", async () => {
  api.doctor.mockReset().mockResolvedValue([{ name: "spool", ok: true, detail: "writable" }]);
  const p = createDoctor({ issues: () => issues, onInspectWarning: async () => null, onInspectGap: () => {} });
  await p.refresh();
  await settle();
  warnBtn(p).click();
  await settle();
  expect(statusOf(p).hidden).toBe(true);
});

test("a gap selected while a warning is loading keeps the status clear when the warning then fails", async () => {
  api.doctor.mockReset().mockResolvedValue([{ name: "spool", ok: true, detail: "writable" }]);
  let fail!: (ok: boolean) => void;
  const p = createDoctor({ issues: () => issues, onInspectWarning: () => new Promise<boolean>((r) => { fail = r; }), onInspectGap: () => {} });
  await p.refresh();
  await settle();
  warnBtn(p).click();
  gapBtn(p).click();
  fail(false);
  await settle();
  expect(statusOf(p).hidden).toBe(true);
});

test("an older warning failure after a newer warning succeeded does not show the error", async () => {
  api.doctor.mockReset().mockResolvedValue([{ name: "spool", ok: true, detail: "writable" }]);
  const done: Array<(ok: boolean) => void> = [];
  const p = createDoctor({ issues: () => issues, onInspectWarning: () => new Promise<boolean>((r) => { done.push(r); }), onInspectGap: () => {} });
  await p.refresh();
  await settle();
  warnBtn(p).click();
  warnBtn(p).click();
  done[1](true);
  done[0](false);
  await settle();
  expect(statusOf(p).hidden).toBe(true);
});

test("a repaint of the warnings keeps focus on the inspection button that had it, and leaves other focus alone", async () => {
  let resolve!: (v: { name: string; ok: boolean; detail: string }[]) => void;
  api.doctor.mockReset().mockReturnValue(new Promise((r) => (resolve = r)));
  const p = createDoctor({ issues: () => issues, onInspectWarning: () => {}, onInspectGap: () => {} });
  document.body.append(p.root);
  const pending = p.refresh();
  warnBtn(p).focus();
  expect(document.activeElement).toBe(warnBtn(p));
  resolve([{ name: "spool", ok: true, detail: "writable" }]);
  await pending;
  await settle();
  expect(document.activeElement).toBe(warnBtn(p));
  expect(document.activeElement!.getAttribute("data-key")).toBe("warning:w1");
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  p.redraw();
  expect(document.activeElement).toBe(outside);
  p.root.remove();
  outside.remove();
});

test("when the focused warning is gone after a repaint, focus lands on Doctor rather than the document", async () => {
  api.doctor.mockReset().mockResolvedValue([]);
  let now = issues;
  const p = createDoctor({ issues: () => now, onInspectWarning: () => {}, onInspectGap: () => {} });
  document.body.append(p.root);
  await p.refresh();
  await settle();
  warnBtn(p).focus();
  now = { gaps: issues.gaps, warnings: [] };
  p.redraw();
  expect(document.activeElement).toBe(p.root);
  p.root.remove();
});
