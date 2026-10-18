import { expect, test } from "vitest";
import type { ErrorSignature, FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
import { buildLoops } from "./model";
const sid = "019fd182-8513-7461-a816-e786f1fe439e";
const events = (fixture as FirehoseEvent[]).filter(e => e.session_id === sid);

test("real recurring errors use loaded counts and consecutive interval boundaries", () => {
  const model = buildLoops([...events].reverse().concat(events), sid);
  expect(model.groups).toHaveLength(1);
  const group = model.groups[0];
  expect(group.occurrences).toHaveLength(2);
  expect(group.intervals).toHaveLength(1);
  expect(group.intervals[0].counts).toEqual({shell: 1});
  expect(model.events).toHaveLength(events.length);
  expect(model.fallbackCount).toBe(2);
});

test("authoritative members override local identities without trusting global counts", () => {
  const sig = {key: "authoritative", source: "codex", members: events.map(e => e.id), count: 900} as ErrorSignature;
  const model = buildLoops(events, sid, undefined, [sig]);
  expect(model.groups[0].key).toBe("authoritative");
  expect(model.groups[0].occurrences).toHaveLength(2);
  expect(model.fallbackCount).toBe(0);
});

test("isolates scope, ignores invalid times and transitions, and orders same-time ids", () => {
  const first = events[0];
  const changed = [
    {...first, id: "z", time: events[1].time},
    {...first, id: "a", time: events[1].time},
    {...first, id: "foreign", session_id: "other"},
    {...first, id: "other-source", source: "other"},
    {...first, id: "bad", time: "invalid"},
    {...first, id: "transition", name: "state_changed", category: "session", source: "firehose", payload: {state: "needs_input"}},
  ];
  const model = buildLoops(changed, sid, "codex");
  expect(model.events.map(e => e.id)).toEqual(["a", "z"]);
  expect(model.groups[0].intervals[0].elapsedMs).toBe(0);
  expect(model.groups[0].intervals[0].counts).toEqual({shell: 1});
  expect(buildLoops([first], sid).groups).toEqual([]);
  expect(buildLoops([], sid).groups).toEqual([]);
});

test("synthetic transitions never count even without a source filter", () => {
  const transition = {...events[0], id: "transition", source: "firehose", name: "state.transition"};
  expect(buildLoops([...events, transition], sid).events).toHaveLength(2);
});

test("partially supplied members disclose fallback for the remaining observations", () => {
  const key = "codex|shell|PostToolUse|failed: mix test";
  const sig = { key, source: "codex", members: [events[0].id], count: 5000 } as ErrorSignature;
  const model = buildLoops(events, sid, undefined, [sig]);
  expect(model.groups[0].occurrences).toHaveLength(2);
  expect(model.fallbackCount).toBe(1);
});

test("different sources and signatures do not become one recurrence", () => {
  const data = [...events, ...events.map(e => ({...e, id: `other-${e.id}`, source: "other"})), {...events[0], id: "another-error", summary: "a different failure"}];
  const model = buildLoops(data, sid);
  expect(model.groups).toHaveLength(2);
  expect(model.groups.map(g => g.occurrences.length)).toEqual([2, 2]);
});

test("discloses invalid times and duplicates separately, with fallback per group", () => {
  const result = buildLoops([...events, events[0], {...events[0], id: "bad-time", time: "invalid"}], sid);
  expect(result.excluded).toEqual({invalidTime: 1, duplicate: 1});
  expect(result.groups[0].fallbackOccurrences).toBe(2);
});

test("100k fixture-derived events retain exact interleaved recurrence counts", () => {
  const start = Date.parse(events[0].time);
  const names = ["alpha", "beta", "gamma"];
  const history = Array.from({length: 100_000}, (_, i) => ({
    ...events[0], id: `scale-${i}`, time: new Date(start + i).toISOString(),
    category: i % 5 === 0 ? "shell" : "file", severity: i % 5 === 0 ? "error" : "info",
    summary: `failure ${names[i % 3]}`,
  }));
  const model = buildLoops(history, sid);
  expect(model.events).toHaveLength(100_000);
  expect(model.groups).toHaveLength(3);
  expect(model.groups.map(g => g.occurrences.length).sort()).toEqual([6666, 6667, 6667]);
  for (const group of model.groups) {
    expect(group.intervals).toHaveLength(group.occurrences.length - 1);
    expect(group.intervals.every(i => i.counts.file === 12 && i.counts.shell === 3)).toBe(true);
  }
});
