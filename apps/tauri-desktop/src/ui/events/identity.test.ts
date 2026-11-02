// @vitest-environment happy-dom
// Identity guards: one event list for Fleet Events, Project Events and the
// Worktree rung. Static scan of non-test sources plus a key-ownership check.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

import { createEventList, renderEventRows } from "./index";
import { liveSource, timelineView } from "./model";
import { TimelineState } from "../graph/model";
import { FeedState } from "../../state";
import { __resetKeysForTests, listKeys } from "../../keys";
import type { FirehoseEvent } from "../../api";

const SRC = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|css)$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const sources = walk(SRC).map((p) => ({ rel: p.slice(SRC.length + 1), text: readFileSync(p, "utf8") }));
const read = (rel: string) => sources.find((s) => s.rel === rel)!.text;
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("one event list", () => {
  test("the old feed and graph table renderers are gone", () => {
    expect(existsSync(join(SRC, "ui", "feed.ts"))).toBe(false);
    for (const s of sources) {
      expect(s.text, s.rel).not.toMatch(/ui\/feed["']|from ["']\.\/feed["']|from ["']\.\.\/feed["']/);
      expect(s.text, s.rel).not.toMatch(/\bcreateFeed\b|\brenderEventList\b|\brenderTimeline\b|graph-events/);
    }
  });

  test("Fleet and Project Events each build one createEventList; Worktree uses renderEventRows only", () => {
    const makers = sources.filter((s) => /\bcreateEventList\(/.test(s.text) && s.rel !== "ui/events/index.ts").map((s) => s.rel).sort();
    expect(makers).toEqual(["main.ts", "ui/graph/index.ts"]);
    expect(count(read("main.ts"), "createEventList(")).toBe(1);
    expect(count(read("ui/graph/index.ts"), "createEventList(")).toBe(1);
    const sessions = read("ui/sessions.ts");
    expect(sessions).toMatch(/renderEventRows\(/);
    expect(sessions).not.toMatch(/createEventList/);
  });

  test("no code outside ui/events builds a feed-row element or reads feed-row through a hand-rolled builder", () => {
    for (const s of sources) {
      if (s.rel.startsWith("ui/events/") || s.rel === "styles.css") continue;
      expect(s.text, s.rel).not.toMatch(/feed-row/);
    }
  });
});

describe("one row structure across the three scopes", () => {
  beforeEach(() => {
    __resetKeysForTests();
    document.body.replaceChildren();
  });
  const e = (id: string): FirehoseEvent =>
    ({ id, time: "2026-11-01T12:00:00Z", source: "claude-code", category: "tool", summary: id, session_id: "s" }) as FirehoseEvent;
  const shape = (box: HTMLElement) =>
    [...box.querySelectorAll<HTMLElement>(".feed-row")].map((r) => ({
      role: r.getAttribute("role"),
      key: r.getAttribute("data-key"),
      label: r.getAttribute("aria-label"),
      cells: [...r.querySelectorAll(".cell")].map((c) => [...c.classList].filter((x) => x !== "cell")[0]),
    }));

  test("Fleet Events (live), Project Events (timeline) and the Worktree rung emit rows keyed by event id with the same role and label", () => {
    const feed = new FeedState(10);
    feed.push(e("x1"));
    const fleet = createEventList(liveSource(feed), { onSelect: () => {} });
    const ts = new TimelineState();
    ts.merge([e("x1")]);
    const project = createEventList(timelineView(ts, {}), { onSelect: () => {} });
    const rung = document.createElement("div");
    renderEventRows(rung, [e("x1")], () => {});
    document.body.append(fleet.root, project.root, rung);
    fleet.refresh();
    project.refresh();
    const [a, b, c] = [shape(fleet.root), shape(project.root), shape(rung)];
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0].key).toBe("x1");
    expect(a[0].role).toBe("button");
    // The rung's compact variant drops source and workspace but keeps key, role and label.
    expect({ ...c[0], cells: undefined }).toEqual({ ...a[0], cells: undefined });
    expect(c[0].cells).toEqual(["time", "category", "summary"]);
  });
});

describe("events key scope", () => {
  beforeEach(() => {
    __resetKeysForTests();
    document.body.replaceChildren();
  });
  const ev = (id: string): FirehoseEvent =>
    ({ id, time: "2026-11-01T12:00:00Z", source: "claude-code", category: "tool", summary: id, session_id: "s" }) as FirehoseEvent;
  const events = () => listKeys().filter((r) => r.scope === "events");

  test("one registration per active list, no leaks across repeated activate/deactivate", () => {
    const feed = new FeedState(100);
    feed.push(ev("a"));
    const a = createEventList(liveSource(feed), { onSelect: () => {} });
    const b = createEventList(liveSource(feed), { onSelect: () => {} });
    document.body.append(a.root, b.root);
    expect(events()).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      a.activate();
      expect(events()).toHaveLength(1);
      b.activate();
      expect(events()).toHaveLength(1);
      a.deactivate(); // stale owner cannot release b's registration
      expect(events()).toHaveLength(1);
      b.deactivate();
      expect(events()).toHaveLength(0);
    }
  });
});
