// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { ev, att, NOW, iso } from "./model.fixtures";
import { buildLanes } from "../lanes/model";
import { deriveAirspace, BANDS } from "../airspace/model";
import { airspaceBands, lanesStrip, qualifyLaneInput } from "./encodings";

const W = 300_000;
const lanesOf = (events: ReturnType<typeof ev>[]) => buildLanes(qualifyLaneInput(events), [], NOW, W);

describe("lanesStrip", () => {
  const events = [
    ev({ id: "1", session_id: "s1", call_id: "c1", time: iso(NOW - 120_000), payload: { phase: "start" } }),
    ev({ id: "2", session_id: "s1", call_id: "c1", time: iso(NOW - 60_000), payload: { phase: "end" } }),
    ev({ id: "3", session_id: "s1", time: iso(NOW - 30_000), category: "message" }),
    ev({ id: "4", session_id: "s2", source: "codex", agent: "<img src=x onerror=alert(1)>", time: iso(NOW - 10_000) }),
  ];

  test("draws one keyed row per lane with spans, ticks, title; labels are text", () => {
    const lanes = lanesOf(events);
    const svg = lanesStrip(lanes, NOW, W, 600, () => {});
    const rows = svg.querySelectorAll(".fleet-lane-row[data-key]");
    expect(rows.length).toBe(lanes.length);
    expect(lanes.length).toBe(2);
    expect(svg.querySelectorAll("rect.lane-span").length).toBeGreaterThan(0);
    expect(svg.querySelectorAll(".lane-tick").length).toBeGreaterThan(0);
    expect(svg.querySelector("title")).not.toBeNull();
    expect(svg.querySelector("img")).toBeNull();
    expect(svg.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("open spans carry class open", () => {
    const lanes = lanesOf([ev({ id: "1", session_id: "s1", call_id: "c1", time: iso(NOW - 20_000), payload: { phase: "start" } })]);
    const svg = lanesStrip(lanes, NOW, W, 600, () => {});
    expect(svg.querySelector("rect.lane-span.open")).not.toBeNull();
  });

  test("Claude and Codex sharing session_id and call_id stay separate lanes", () => {
    const lanes = lanesOf([
      ev({ id: "1", source: "claude-code", session_id: "s", call_id: "c", time: iso(NOW - 40_000), payload: { phase: "start" } }),
      ev({ id: "2", source: "codex", session_id: "s", call_id: "c", time: iso(NOW - 20_000), payload: { phase: "end" } }),
    ]);
    expect(lanes.length).toBe(2);
    const spans = lanes.flatMap((l) => l.spans);
    expect(spans.every((s) => s.open)).toBe(true);
    expect(spans.length).toBe(1);
  });

  test("onOpen receives decoded id and source via click, Enter and Space", () => {
    const onOpen = vi.fn();
    const lanes = lanesOf([ev({ id: "1", source: "codex", session_id: "sess-9", time: iso(NOW - 5_000) })]);
    const svg = lanesStrip(lanes, NOW, W, 600, onOpen);
    const row = svg.querySelector(".fleet-lane-row") as Element;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(3);
    for (const c of onOpen.mock.calls) expect(c).toEqual(["sess-9", "codex"]);
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("role")).toBe("button");
  });

  test("sourceOf supplies the source for unqualified ids", () => {
    const onOpen = vi.fn();
    const svg = lanesStrip(
      [{ id: "plain", label: "p", state: "working", lastAt: NOW, ticks: [], spans: [] }],
      NOW, W, 600, onOpen, (id) => (id === "plain" ? "opencode" : undefined),
    );
    svg.querySelector(".fleet-lane-row")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith("plain", "opencode");
  });

  test("empty state", () => {
    const svg = lanesStrip([], NOW, W, 600, () => {});
    expect(svg.querySelector(".lane-empty")!.textContent).toBe("no live sessions");
    expect(svg.querySelectorAll(".fleet-lane-row").length).toBe(0);
  });
});

describe("airspaceBands", () => {
  test("one chip per band in order, zero chips marked, labelled, no running/idle claims", () => {
    const d = deriveAirspace([att({ id: "a", waitMs: 5_000 }), att({ id: "b", state: "done" })], { now: NOW, windowMs: 900_000 });
    const el = airspaceBands(d);
    expect(el.getAttribute("aria-label")).toBe("Needs-you bands");
    const chips = [...el.querySelectorAll(".fleet-band")];
    expect(chips.length).toBe(BANDS.length);
    chips.forEach((c, i) => {
      expect(c.textContent).toContain(BANDS[i].label);
      expect(c.classList.contains("zero")).toBe(d.counts[BANDS[i].id] === 0);
    });
    expect(chips.some((c) => c.classList.contains("zero"))).toBe(true);
    expect(el.textContent!.toLowerCase()).not.toMatch(/running|idle/);
  });
});

describe("qualifyLaneInput origin", () => {
  test("a synthetic transition lands on its originating source's lane", () => {
    const lanes = lanesOf([
      ev({ id: "1", source: "codex", session_id: "s", time: iso(NOW - 20_000) }),
      ev({ id: "2", source: "firehose", category: "meta", name: "state.transition", session_id: "s", time: iso(NOW - 10_000), payload: { state: "needs_input", source: "codex" } }),
    ]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.ticks.some((t) => t.kind === "needs")).toBe(true);
  });

  test("non-transition meta events are dropped", () => {
    expect(qualifyLaneInput([ev({ id: "m", session_id: "s", category: "meta", name: "PreCompact" })])).toHaveLength(0);
  });
});

describe("lane aria-label names the state", () => {
  test("needs_input lane says needs you; working lane is unchanged", () => {
    const lanes = lanesOf([ev({ id: "1", session_id: "s1", time: iso(NOW - 5_000) })]);
    const working = lanesStrip(lanes, NOW, W, 600, () => {}).querySelector(".fleet-lane-row")!;
    expect(working.getAttribute("aria-label")).toBe(`open session ${lanes[0]!.label}`);
    const needy = [{ ...lanes[0]!, state: "needs_input" }];
    const row = lanesStrip(needy, NOW, W, 600, () => {}).querySelector(".fleet-lane-row")!;
    expect(row.getAttribute("aria-label")).toBe(`open session ${needy[0]!.label}, needs you`);
    expect(row.querySelector("title")!.textContent).toContain("needs you");
  });
});

describe("lane stripe identity", () => {
  test("stays the data-derived session hue, never a state token", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/ui/fleet/encodings.ts", "utf8");
    expect(src).toContain("hsl(${sessionHue(lane.id)} 55% 55%)");
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    const stripe = src.split("\n").find((l) => l.includes("width: 3"))!;
    expect(stripe).not.toMatch(/var\(--/);
  });
});
