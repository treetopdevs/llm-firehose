import { expect, test } from "vitest";
import records from "../../../../internal/capture/testdata/activity_real_shapes.ndjson?raw";
import { recordedFilePaths, recordedFileScope } from "./files";
import type { FirehoseEvent } from "../api";
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
