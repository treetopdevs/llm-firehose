import { expect, test } from "vitest";
import records from "../../../../internal/capture/testdata/activity_real_shapes.ndjson?raw";
import { recordedFilePaths, recordedFileScope, comparableFileScope, matchesFileReceipt } from "./files";
import type { FirehoseEvent, FileSession } from "../api";
test("path extraction agrees with the Go projection on the shared real Codex fixture", () => {
  const real = records
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FirehoseEvent)
    .find((e) => e.name === "patch_apply_end")!;
  expect(recordedFilePaths(real)).toEqual([
    "/work/proj/test/pipeline/identifier_resolution_test.exs",
  ]);
  // Normalized privacy and metadata mutations, not new adapter payload fixtures.
  expect(
    recordedFilePaths({
      ...real,
      payload: { changes: { sha256: "hash", len: 2 } },
    }),
  ).toEqual([]);
  expect(
    recordedFilePaths({
      ...real,
      payload: { file_path: "first", path: "second", file: "third" },
    }),
  ).toEqual(["first"]);
  expect(
    recordedFileScope({
      ...real,
      worktree_id: "a",
      jj_workspace_id: "b",
      cwd: "c",
    }),
  ).toEqual(["worktree_id", "a"]);
});

test("shared comparability rejects empty kinds and receipt matching preserves absent session semantics", () => {
  const real = records.trim().split("\n").map(line => JSON.parse(line) as FirehoseEvent).find(e => e.name === "patch_apply_end")!;
  const event = { ...real, session_id: undefined };
  const [workspace_kind, workspace] = recordedFileScope(event);
  const row: FileSession = { workspace_kind, workspace, path: recordedFilePaths(event)[0], source: event.source, session_id: "", last_event_id: event.id, first_time: event.time, last_time: event.time, events: 1 };
  expect(comparableFileScope({ ...row, workspace_kind: "", workspace: "/work" })).toBe(false);
  expect(matchesFileReceipt(row, event)).toBe(true);
  expect(matchesFileReceipt({ ...row, path: "wrong" }, event)).toBe(false);
});
