import { expect, test } from "vitest";
import type { FirehoseEvent } from "../../api";
import captured from "../score/fixture.errsig.json";
import { buildLoom, loomNeighborhood } from "./model";

const session = "019fd182-8513-7461-a816-e786f1fe439e";
const real = (captured as FirehoseEvent[]).filter(e => e.source === "codex" && e.session_id === session);
const key = (kind: string, id: string) => JSON.stringify([kind, id]);

test("real Codex receipts form explicit call and shared turn groups without causal edges", () => {
  const model = buildLoom(captured as FirehoseEvent[], "codex", session);
  expect(model.events).toEqual(real);
  expect(model.groups).toHaveLength(3);
  expect(model.groups.find(g => g.kind === "turn")?.members).toEqual(real.map(e => e.id));
  expect(model.parents).toEqual([]);
  expect(loomNeighborhood(model, real[0].id).groups.map(g => g.kind).sort()).toEqual(["call", "turn"]);
});

test("scope filtering happens before dedupe and equal native strings stay in distinct namespaces", () => {
  const altered = {...real[0], call_id: "same", turn_id: "same", prompt_id: "same", message_id: "same", trace_id: "same", request_id: "same"};
  const model = buildLoom([altered, {...altered, source: "other", call_id: "different"}, {...altered, session_id: "other", turn_id: "different"}], "codex", session);
  expect(model.events).toEqual([altered]);
  expect(model.groups).toHaveLength(6);
  expect(new Set(model.groups.map(g => g.key)).size).toBe(6);
  expect(model.groups.find(g => g.kind === "call")?.key).toBe(key("call", "same"));
  expect(model.conflicts).toBe(0);
  expect(model.duplicates).toBe(0);
});

test("duplicates collapse; conflicting captured ids are excluded completely and input remains untouched", () => {
  const input = [real[0], {...real[0]}, real[1], {...real[1], call_id: "different-call"}, {...real[0], id: ""}];
  const before = JSON.stringify(input);
  const model = buildLoom(input, "codex", session);
  expect(model.events).toEqual([real[0]]);
  expect(model.duplicates).toBe(2);
  expect(model.conflicts).toBe(1);
  expect(model.omitted).toBe(1);
  expect(model.groups.every(g => !g.members.includes(real[1].id))).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  expect(buildLoom([...input].reverse(), "codex", session)).toEqual(model);
});

test("invalid clocks remain inspectable and sort after valid times, then by id", () => {
  const a = {...real[0], id: "a", time: "bad"};
  const z = {...a, id: "z"};
  const model = buildLoom([z, real[1], a, real[0]], "codex", session);
  expect(model.events.map(e => e.id)).toEqual([...real.map(e => e.id), "a", "z"]);
  expect(model.invalidTimes).toBe(2);
});

test("generic parent and upstream identities remain unsupported metadata", () => {
  const e = {...real[0], parent_id: real[1].id, upstream_event_id: real[1].id};
  const model = buildLoom([e, real[1]], "codex", session);
  expect(model.parents).toEqual([]);
  expect(model.unsupportedParents).toBe(2);
  expect(loomNeighborhood(model, "missing")).toEqual({groups: [], parents: []});
});

import native from "./fixture.opencode.json";
const opencode = native as FirehoseEvent[];
const nativeSession = "ses_fixture01";

test("real OpenCode messages resolve a native parent; terminal-only tool is just membership", () => {
  const model = buildLoom(opencode, "opencode", nativeSession);
  expect(model.parents).toHaveLength(1);
  expect(model.parents[0]).toMatchObject({parentKey: key("message", "msg_fixture04"), childKey: key("message", "msg_fixture01"), status: "resolved", evidenceIds: ["loom-assistant"]});
  expect(model.groups.find(g => g.id === "msg_fixture01")?.members).toEqual(["loom-assistant", "loom-tool"]);
  expect(model.groups.find(g => g.kind === "call")?.members).toEqual(["loom-tool"]);
  expect(model.unsupportedParents).toBe(3); // upstream receipt identities are metadata, never joins
  const neighborhood = loomNeighborhood(model, "loom-tool");
  expect(neighborhood.groups.map(g => g.id).sort()).toEqual(["call_fixture03", "msg_fixture01", "msg_fixture04"]);
  expect(neighborhood.parents).toEqual(model.parents);
});

test("missing parent is a zero-member message group, not a captured-event join", () => {
  const model = buildLoom(opencode.slice(1), "opencode", nativeSession);
  expect(model.parents[0].status).toBe("missing");
  expect(model.groups.find(g => g.id === "msg_fixture04")?.members).toEqual([]);
});

test("multiple parents and self-reference are conflicting without choosing a parent", () => {
  const extra = {...opencode[1], id: "other-parent", parent_id: "another-native-message"};
  const model = buildLoom([...opencode, extra], "opencode", nativeSession);
  expect(model.parents).toHaveLength(2);
  expect(model.parents.every(p => p.status === "conflicting")).toBe(true);
  const self = buildLoom([{...opencode[1], parent_id: opencode[1].message_id}], "opencode", nativeSession);
  expect(self.parents[0].status).toBe("conflicting");
});

test("multiple receipts for one message keep every receipt and combine parent evidence", () => {
  const repeated = {...opencode[1], id: "another-receipt"};
  const model = buildLoom([...opencode, repeated], "opencode", nativeSession);
  expect(model.groups.find(g => g.id === "msg_fixture01")?.members).toHaveLength(3);
  expect(model.parents).toHaveLength(1);
  expect(model.parents[0].evidenceIds.sort()).toEqual(["another-receipt", "loom-assistant"]);
});

test("one-hop neighborhoods do not recursively follow chains or cycles", () => {
  const grandparent = {...opencode[1], id: "grandparent-receipt", message_id: "msg_fixture04", parent_id: "grandparent"};
  const beyond = {...opencode[1], id: "beyond-receipt", message_id: "grandparent", parent_id: "msg_fixture01"};
  const model = buildLoom([...opencode, grandparent, beyond], "opencode", nativeSession);
  const neighborhood = loomNeighborhood(model, "loom-tool");
  expect(neighborhood.parents).toHaveLength(2); // incoming and outgoing one-hop only
  expect(neighborhood.parents.some(p => p.childKey === key("message", "msg_fixture04"))).toBe(false);
});

test("foreign scopes cannot resolve a parent and unsupported OpenCode parents never join", () => {
  const toolParent = {...opencode[2], parent_id: "msg_fixture04"};
  const model = buildLoom([
    {...opencode[0], session_id: "foreign"},
    {...opencode[0], source: "foreign"},
    opencode[1], toolParent,
  ], "opencode", nativeSession);
  expect(model.parents).toHaveLength(1);
  expect(model.parents[0].status).toBe("missing");
  expect(model.unsupportedParents).toBe(3); // two upstream references plus unsupported tool parent
});

test("property-order differences are duplicates, not conflicts", () => {
  const reordered = Object.fromEntries(Object.entries(opencode[2]).reverse()) as unknown as FirehoseEvent;
  const model = buildLoom([opencode[2], reordered], "opencode", nativeSession);
  expect(model.events).toHaveLength(1);
  expect(model.duplicates).toBe(1);
  expect(model.conflicts).toBe(0);
});

test("10k real-shape tool receipts keep exact memberships and a one-hop neighborhood", () => {
  const tools = Array.from({length: 10_000}, (_, i) => ({...opencode[2], id: `tool-${String(i).padStart(5, "0")}`, call_id: `call-${i}`}));
  const model = buildLoom([...opencode.slice(0, 2), ...tools], "opencode", nativeSession);
  expect(model.events).toHaveLength(10_002);
  expect(model.groups).toHaveLength(10_002);
  expect(model.groups.find(g => g.id === "msg_fixture01")?.members).toHaveLength(10_001);
  const neighborhood = loomNeighborhood(model, tools[0].id);
  expect(neighborhood.groups).toHaveLength(3);
  expect(neighborhood.parents).toHaveLength(1);
});
