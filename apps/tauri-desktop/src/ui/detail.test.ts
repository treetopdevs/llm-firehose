// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";

import { renderDetail } from "./detail";
import type { FirehoseEvent } from "../api";

const t0 = Date.parse("2026-07-02T10:04:12.310Z");

function ev(over: Partial<FirehoseEvent> & { id: string }): FirehoseEvent {
  return {
    time: new Date(t0).toISOString(),
    source: "claude-code",
    agent: "claude",
    session_id: "30c5b813-610c-4136-9dbd-eeafbff72c2a",
    category: "shell",
    summary: "ran: go test ./...",
    cwd: "/home/me/dev/app",
    ...over,
  };
}

function pair(): [FirehoseEvent, FirehoseEvent] {
  const start = ev({
    id: "e1",
    call_id: "c1",
    turn_id: "t1",
    payload: { phase: "start", tool_name: "Bash", command: "go test ./..." },
  });
  const end = ev({
    id: "e2",
    call_id: "c1",
    turn_id: "t1",
    time: new Date(t0 + 2590).toISOString(),
    source_time: new Date(t0 + 2590 - 42).toISOString(),
    capture_time: new Date(t0 + 2590).toISOString(),
    payload: { phase: "end", tool_name: "Bash", exit_code: 0, stdout: { sha256: "abcdef0123456789", len: 512 } },
  });
  return [start, end];
}

function rows(pane: HTMLElement, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dl of pane.querySelectorAll(selector)) {
    const dts = [...dl.querySelectorAll("dt")];
    const dds = [...dl.querySelectorAll("dd")];
    dts.forEach((dt, i) => {
      out[dt.textContent ?? ""] = dds[i]?.textContent ?? "";
    });
  }
  return out;
}

describe("renderDetail", () => {
  test("pairs request and response by call id and tabulates the payload", () => {
    const pane = document.createElement("aside");
    const [start, end] = pair();
    renderDetail(pane, end, () => {}, () => [start, end]);

    expect(pane.classList.contains("open")).toBe(true);
    expect(pane.querySelector(".detail-crumb")?.textContent).toBe("…/dev/app · claude · session 30c5b813");
    expect(pane.querySelector(".detail-headline")?.textContent).toContain("shell");
    expect(pane.querySelector(".detail-headline")?.textContent).toContain("Bash");
    const meta = rows(pane, ".detail-meta");
    expect(meta.started).toMatch(/^\d\d:\d\d:\d\d\.310$/);
    expect(meta.ended).toMatch(/\.900  2\.59s$/);
    expect(meta.captured).toBe("+42ms after source");
    expect(meta.ids).toBe("session 30c5b813-610c-4136-9dbd-eeafbff72c2a · turn t1 · call c1");
    expect(meta.cwd).toBe("/home/me/dev/app");

    const sections = [...pane.querySelectorAll("h3")].map((h) => h.textContent);
    expect(sections).toEqual(["request", "response"]);
    const request = rows(pane, ".detail-kv.request");
    expect(request).toEqual({ command: "go test ./..." });
    const response = rows(pane, ".detail-kv.response");
    expect(response).toEqual({ exit_code: "0", stdout: "#abcdef01 · len 512" });

    const json = pane.querySelector<HTMLDetailsElement>("details");
    expect(json?.open).toBe(false);
    expect(json?.querySelector("pre")?.textContent).toContain('"exit_code": 0');
  });

  test("an unpaired call says so, and an event without a call shows its time", () => {
    const pane = document.createElement("aside");
    const [start] = pair();
    renderDetail(pane, start, () => {}, () => [start]);
    expect(rows(pane, ".detail-meta").ended).toBe("no end captured");
    expect([...pane.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["request"]);

    const plain = ev({ id: "p1", category: "prompt", summary: 'prompt: "hi"', payload: { text: "hi" } });
    renderDetail(pane, plain, () => {});
    const meta = rows(pane, ".detail-meta");
    expect(meta.time).toMatch(/\.310$/);
    expect(meta.started).toBeUndefined();
    expect([...pane.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["payload"]);
    expect(rows(pane, ".detail-kv")).toEqual({ text: "hi" });
  });

  test("coalesces dual observations of one phase the way the feed does", () => {
    const pane = document.createElement("aside");
    const [start, end] = pair();
    const rollout = { ...end, id: "e2b", time: new Date(t0 + 2610).toISOString() };
    renderDetail(pane, start, () => {}, () => [start, end, rollout]);
    const meta = rows(pane, ".detail-meta");
    expect(meta.ended).toMatch(/\.920  2\.61s$/);
    expect([...pane.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["request", "response"]);
  });

  test("pairs a call whose end arrived before its start", () => {
    const pane = document.createElement("aside");
    const [start, end] = pair();
    renderDetail(pane, end, () => {}, () => [end, start]);
    expect(rows(pane, ".detail-meta").ended).toMatch(/\.900  2\.59s$/);
  });

  test("closes on the button and clears on null", () => {
    const pane = document.createElement("aside");
    let closed = 0;
    renderDetail(pane, ev({ id: "x" }), () => closed++);
    pane.querySelector<HTMLButtonElement>(".detail-close")!.click();
    expect(closed).toBe(1);
    renderDetail(pane, null, () => {});
    expect(pane.classList.contains("open")).toBe(false);
    expect(pane.childElementCount).toBe(0);
  });
});
