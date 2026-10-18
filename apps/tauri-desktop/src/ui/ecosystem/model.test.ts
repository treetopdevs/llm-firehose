import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.session.json";
import { buildEcosystem, patchPhase, replayBeds } from "./model";

const events = fixture as FirehoseEvent[];
const source = events[0].source;
const session = events[0].session_id!;
const files = events.filter(e => e.category === "file");
const realShapes = readFileSync(new URL("../../../../../internal/capture/testdata/activity_real_shapes.ndjson", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line) as FirehoseEvent);

test("real file receipts retain observations rather than coalescing edits", () => {
  const model = buildEcosystem(events, source, session);
  expect(model.events).toHaveLength(20);
  expect(model.beds).toHaveLength(4);
  expect(model.beds.reduce((n, b) => n + b.eventIds.length, 0)).toBe(20);
  expect(model.events.filter(e => patchPhase(e) === "attempt")).toHaveLength(10);
  expect(model.events.filter(e => patchPhase(e) === "complete")).toHaveLength(10);
  expect(model.missingPaths).toBe(0);
});

test("exact scope precedes file dedupe and workspace/path strings remain distinct", () => {
  const first = files[0];
  const altered = [first, {...first, source: "other"}, {...first, session_id: "other"}, {...first, id: "worktree", worktree_id: "different"}, {...first, id: "path", payload: {...first.payload, file_path: String(first.payload!.file_path).toUpperCase()}}];
  const model = buildEcosystem(altered, source, session);
  expect(model.events).toHaveLength(3);
  expect(model.beds).toHaveLength(3);
  expect(model.duplicates).toBe(0);
  expect(model.beds.some(b => b.workspace === "worktree_id:different")).toBe(true);
});

test("duplicate/conflicting IDs and missing file IDs are counted without mutation", () => {
  const input = [files[0], {...files[0]}, files[1], {...files[1], summary: "different"}, {...files[2], id: ""}, {...events[0], id: ""}];
  const saved = JSON.stringify(input);
  const model = buildEcosystem(input, source, session);
  expect(model.events).toEqual([files[0]]);
  expect(model.duplicates).toBe(2);
  expect(model.conflicts).toBe(1);
  expect(model.missingIds).toBe(1); // only scoped file observations
  expect(JSON.stringify(input)).toBe(saved);
  expect(buildEcosystem([...input].reverse(), source, session)).toEqual(model);
});

test("undated file receipts remain separate from temporal beds and replay", () => {
  const invalid = {...files[0], id: "undated", time: "invalid"};
  const model = buildEcosystem([invalid, files[1]], source, session);
  expect(model.events).toEqual([files[1]]);
  expect(model.undated).toEqual([invalid]);
  expect(model.beds[0].eventIds).toEqual([files[1].id]);
  const prefix = replayBeds(model, 0);
  expect(prefix.map(b => b.key)).toEqual(model.beds.map(b => b.key));
  expect(prefix[0].eventIds).toEqual([]);
  expect(replayBeds(model, 1)).toEqual(model.beds);
});

test("replay clamps cursor and preserves every bed position while restricting memberships", () => {
  const model = buildEcosystem(events, source, session);
  const before = JSON.stringify(model);
  for (const cursor of [-1, 0, 1, 5, 999, NaN]) {
    const beds = replayBeds(model, cursor);
    expect(beds.map(b => b.key)).toEqual(model.beds.map(b => b.key));
    const count = Number.isNaN(cursor) ? 0 : Math.max(0, Math.min(cursor, model.events.length));
    expect(beds.reduce((sum, b) => sum + b.eventIds.length, 0)).toBe(count);
  }
  expect(JSON.stringify(model)).toBe(before);
});

test("actual Codex changes map gives observed path; patch text is not parsed", () => {
  const patch = realShapes.find(e => e.name === "patch_apply_end")!;
  const model = buildEcosystem([patch], patch.source, patch.session_id!);
  expect(model.beds.map(b => b.path)).toEqual(["/work/proj/test/pipeline/identifier_resolution_test.exs"]);
  const text = realShapes.find(e => e.name === "custom_tool_call:apply_patch")!;
  const unknown = buildEcosystem([text], text.source, text.session_id!);
  expect(unknown.events).toHaveLength(1);
  expect(unknown.missingPaths).toBe(1);
  expect(unknown.beds).toEqual([]);
  expect(patchPhase(text)).toBe("attempt"); // actual phase=start,status=completed
});

// Normalized envelope contract mutations of real receipts, not invented raw
// adapter payloads. The changes-map shape comes from activity_real_shapes.ndjson.
test("multipath observations keep exact paths; privacy digests never become file beds", () => {
  const patch = realShapes.find(e => e.name === "patch_apply_end")!;
  const original = patch.payload!.changes as Record<string, unknown>;
  const path = Object.keys(original)[0];
  const multiple = {...patch, payload: {...patch.payload, changes: {...original, "relative/Second.exs": original[path]}}};
  const model = buildEcosystem([multiple], patch.source, patch.session_id!);
  expect(model.events).toHaveLength(1);
  expect(model.beds.map(b => b.path).sort()).toEqual([path, "relative/Second.exs"].sort());
  expect(model.beds.every(b => b.eventIds.length === 1)).toBe(true);
  const digest = {...patch, payload: {...patch.payload, file_path: {sha256: "digest", len: 12}, changes: {sha256: "digest", len: 300}}};
  const privateModel = buildEcosystem([digest], patch.source, patch.session_id!);
  expect(privateModel.beds).toEqual([]);
  expect(privateModel.missingPaths).toBe(1);
});

test("path precedence skips empty/non-string values and retains exact stored labels", () => {
  const event = {...files[0], payload: {...files[0].payload, file_path: "", path: "Relative\\Path…", file: "other", changes: {ignored: {}}}};
  expect(buildEcosystem([event], source, session).beds[0].path).toBe("Relative\\Path…");
  const file = {...event, payload: {...event.payload, path: {sha256: "digest", len: 5}}};
  expect(buildEcosystem([file], source, session).beds[0].path).toBe("other");
});

test("workspace precedence prefixes fields and unknown identity stays explicit", () => {
  const base = {...files[0], worktree_id: undefined, cwd: undefined, repo_id: undefined, repo: undefined};
  const variants = [base, {...base, id: "cwd", cwd: "identity"}, {...base, id: "repo-id", repo_id: "identity"}, {...base, id: "repo", repo: "identity"}];
  const model = buildEcosystem(variants, source, session);
  expect(model.beds.map(b => b.workspace).sort()).toEqual(["cwd:identity", "repo:identity", "repo_id:identity", "unknown"].sort());
});

test("failed stage wins, then attempt, then source-reported completion", () => {
  for (const status of ["error", "failed", "interrupted"]) expect(patchPhase({...files[0], payload: {...files[0].payload, status}})).toBe("failed");
  expect(patchPhase({...files[1], severity: "error"})).toBe("failed");
  expect(patchPhase({...files[1], payload: {status: "started"}})).toBe("attempt");
  expect(patchPhase({...files[1], payload: {status: "completed"}})).toBe("complete");
  expect(patchPhase({...files[1], payload: {status: "finished"}})).toBe("unknown");
});

test("equal times order by ID, fractional cursors floor and replay result mutation is isolated", () => {
  const input = [{...files[0], id: "z"}, {...files[0], id: "a"}];
  const model = buildEcosystem(input, source, session);
  expect(model.events.map(e => e.id)).toEqual(["a", "z"]);
  expect(replayBeds(model, 1.9)[0].eventIds).toEqual(["a"]);
  expect(replayBeds(model, Infinity)[0].eventIds).toEqual(["a", "z"]);
  const replay = replayBeds(model, 2);
  replay[0].eventIds.pop();
  expect(model.beds[0].eventIds).toHaveLength(2);
});

test("10k fixture-derived receipts keep stable bed counts and exact replay prefix", () => {
  const history = Array.from({length: 10_000}, (_, i) => ({...files[i % files.length], id: `scale-${i}`, time: new Date(1_800_000_000_000 + i).toISOString()}));
  const model = buildEcosystem(history, source, session);
  expect(model.events).toHaveLength(10_000);
  expect(model.beds).toHaveLength(4);
  expect(replayBeds(model, 2345).reduce((n, bed) => n + bed.eventIds.length, 0)).toBe(2345);
});

// Normalized contract mutations of the captured file receipt.
test("RFC3339 clocks preserve fractional order and reject invalid calendar strings", () => {
 const times=[['a','2026-10-18T12:00:00.000002Z'],['z','2026-10-18T08:00:00.000001-04:00'],['bad','2026-02-30T00:00:00Z'],['loose','1']];
 const model=buildEcosystem(times.map(([id,time])=>({...files[0],id,time})),source,session);
 expect(model.events.map(e=>e.id)).toEqual(['z','a']);
 expect(model.undated.map(e=>e.id)).toEqual(['bad','loose']);
});
