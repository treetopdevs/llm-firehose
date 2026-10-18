import { expect, test } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.session.json";
import { buildReplayRoute } from "./model";
const real = fixture as FirehoseEvent[];
const source = real[0].source;
const session = real[0].session_id!;

test("all real captured categories remain in exact-scope observed route", () => {
  const route = buildReplayRoute(real, source, session);
  expect(route.events).toHaveLength(101);
  expect(route.events[0].id).toBe(real[0].id);
  expect(route.events.map(e => Date.parse(e.time))).toEqual(route.events.map(e => Date.parse(e.time)).sort((a,b) => a-b));
  expect(route.missingIds + route.duplicates + route.conflicts + route.invalidTimes).toBe(0);
  expect(buildReplayRoute(real, "other", session).events).toEqual([]);
});

test("dedupe follows exact scope, conflicts excluded entirely, source input unchanged", () => {
  // Normalized contract negative-case identity mutations, not raw adapter fixtures.
  const input = [real[0], {...real[0]}, {...real[0], source: "other", summary: "foreign"}, {...real[0], session_id: "other", summary: "foreign"}, real[1], {...real[1], summary: "conflict"}, {...real[2], id: ""}];
  const before = JSON.stringify(input);
  const route = buildReplayRoute(input, source, session);
  expect(route.events).toEqual([real[0]]);
  expect(route.duplicates).toBe(2); expect(route.conflicts).toBe(1); expect(route.missingIds).toBe(1);
  expect(JSON.stringify(input)).toBe(before);
  expect(buildReplayRoute([...input].reverse(), source, session)).toEqual(route);
});

test("invalid clocks stay inspectable after valid dates and ties sort by captured ID", () => {
  const input = [{...real[0], id: "z"}, {...real[0], id: "a"}, {...real[0], id: "late-invalid", time: "bad"}, {...real[0], id: "early-invalid", time: "bad"}];
  const route = buildReplayRoute(input, source, session);
  expect(route.events.map(e => e.id)).toEqual(["a", "z", "early-invalid", "late-invalid"]);
  expect(route.invalidTimes).toBe(2);
});

test("object property order is not a metadata conflict", () => {
  const reordered = Object.fromEntries(Object.entries(real[0]).reverse()) as unknown as FirehoseEvent;
  expect(buildReplayRoute([real[0], reordered], source, session)).toMatchObject({events: [real[0]], duplicates: 1, conflicts: 0});
});
