import { expect, test } from "vitest";
import { readReplayBook, saveReplayBook, REPLAY_STORAGE_KEY } from "./notebook";
import type { ReplayBook } from "./notebook";
const book = (): ReplayBook => ({version: 1, branches: [{id: "branch", source: "codex", sessionId: "session", eventId: "event", title: "Try a narrower test", steps: ["Read the failing assertion", "Try a targeted change"]}]});
function storage(initial: string | null = null) {
  let raw = initial;
  const writes: string[] = [];
  return {getItem: (key: string) => { expect(key).toBe(REPLAY_STORAGE_KEY); return raw; }, setItem: (key: string, value: string) => { expect(key).toBe(REPLAY_STORAGE_KEY); raw = value; writes.push(value); }, writes};
}

test("empty storage is writable and valid annotations roundtrip without mutation or captured data", () => {
  const local = storage();
  expect(readReplayBook(local)).toEqual({book: {version: 1, branches: []}, token: null, writable: true});
  const input = book(); const before = JSON.stringify(input);
  const saved = saveReplayBook(local, null, input);
  expect(saved.ok).toBe(true);
  expect(readReplayBook(local)).toEqual({book: input, token: saved.token, writable: true});
  expect(JSON.stringify(input)).toBe(before);
  expect(Object.keys(JSON.parse(local.writes[0]).branches[0]).sort()).toEqual(["eventId", "id", "sessionId", "source", "steps", "title"]);
});

test("corrupt, future, oversize and extra-field stored documents stay read-only and retained", () => {
  for (const raw of ["broken", '{"version":2,"branches":[]}', JSON.stringify({...book(), unexpected: true}), " ".repeat(512 * 1024 + 1)]) {
    const local = storage(raw);
    const read = readReplayBook(local);
    expect(read.writable).toBe(false);
    expect(read.error).toBeTruthy();
    expect(read.token).toBe(raw);
    expect(saveReplayBook(local, raw, book()).ok).toBe(false);
    expect(local.writes).toEqual([]);
    expect(local.getItem(REPLAY_STORAGE_KEY)).toBe(raw);
  }
});

test("optimistic tokens prevent overwriting another window and refresh provides the new token", () => {
  const local = storage(); const earlier = readReplayBook(local);
  const first = saveReplayBook(local, earlier.token, book()); expect(first.ok).toBe(true);
  const changed = book(); changed.branches[0].title = "Another alternative";
  const conflict = saveReplayBook(local, earlier.token, changed);
  expect(conflict.ok).toBe(false); expect(conflict.error).toMatch(/refresh/i);
  expect(local.writes).toHaveLength(1);
  expect(saveReplayBook(local, readReplayBook(local).token, changed).ok).toBe(true);
});

test("storage access failures remain visible without falsely successful saves", () => {
  const inaccessible = {getItem() {throw new Error("blocked");}, setItem() {throw new Error("blocked");}};
  expect(readReplayBook(inaccessible).writable).toBe(false);
  expect(saveReplayBook(inaccessible, null, book()).ok).toBe(false);
  const original = JSON.stringify(book());
  const full = {getItem: () => original, setItem() {throw new Error("quota");}};
  expect(saveReplayBook(full, original, {version: 1, branches: []}).ok).toBe(false);
  expect(full.getItem()).toBe(original);
});

test("strict limits reject invalid hypothetical text, duplicate IDs and copied receipt fields", () => {
  const mutations: ((b: ReplayBook) => void)[] = [
    b => { b.branches[0].title = ""; }, b => { b.branches[0].title = " padded "; },
    b => { b.branches[0].title = "x".repeat(121); }, b => { b.branches[0].steps = []; },
    b => { b.branches[0].steps = [""]; }, b => { b.branches[0].steps = [" padded "]; },
    b => { b.branches[0].steps = ["x".repeat(501)]; }, b => { b.branches[0].steps = Array(13).fill("step"); },
    b => { b.branches[0].eventId = " "; }, b => { b.branches[0].sessionId = "x".repeat(1025); },
    b => { b.branches.push({...b.branches[0]}); },
    b => { b.branches = Array.from({length: 51}, (_, i) => ({...b.branches[0], id: String(i)})); },
    b => { Object.assign(b.branches[0], {payload: {command: "captured"}}); },
  ];
  for (const mutate of mutations) {
    const input = book(); mutate(input); const local = storage();
    expect(saveReplayBook(local, null, input).ok).toBe(false);
    expect(local.writes).toHaveLength(0);
    expect(readReplayBook(storage(JSON.stringify(input))).writable).toBe(false);
  }
});

test("sparse steps cannot serialize a corrupt notebook while claiming save success", () => {
  const input = book(); input.branches[0].steps = new Array(2);
  const local = storage();
  expect(saveReplayBook(local, null, input).ok).toBe(false);
  expect(local.writes).toEqual([]);
});

test("byte budget counts multibyte text and exact field limits remain writable", () => {
  const boundary = book();
  boundary.branches = Array.from({length: 50}, (_, i) => ({...boundary.branches[0], id: String(i), title: "t".repeat(120), steps: Array(12).fill("x".repeat(500)), eventId: "e".repeat(1024), sessionId: "s".repeat(1024), source: "c".repeat(1024)}));
  expect(saveReplayBook(storage(), null, boundary).ok).toBe(true);
  const multibyte = book();
  multibyte.branches = Array.from({length: 50}, (_, i) => ({...multibyte.branches[0], id: String(i), steps: Array(12).fill("漢".repeat(500))}));
  const local = storage();
  expect(saveReplayBook(local, null, multibyte).ok).toBe(false);
  expect(readReplayBook(storage(JSON.stringify(multibyte))).writable).toBe(false);
  expect(local.writes).toEqual([]);
});

test("all required types are checked on read and exact reference text remains untouched", () => {
  for (const raw of ["null", "[]", '{}', '{"version":1,"branches":null}', '{"version":1,"branches":[null]}', '{"version":1,"branches":[1]}']) {
    expect(readReplayBook(storage(raw)).writable).toBe(false);
  }
  const input = book(); input.branches[0].eventId = " exact/reference ";
  const local = storage(); expect(saveReplayBook(local, null, input).ok).toBe(true);
  expect(readReplayBook(local).book.branches[0].eventId).toBe(" exact/reference ");
});
