# Evidence Court notebook TDD

Owned files: apps/tauri-desktop/src/ui/court/notebook.ts and notebook.test.ts.

1. Wrote 24 public persistence API tests before implementation. Focused Vitest run failed resolving absent ./notebook. Red log: /tmp/firehose-court-notebook-red.log.
2. Implemented agreed types, STORAGE_KEY and createNotebook read/save/reload. Focused 24 tests passed.
3. Added strict invalid-shape cases including sparse arrays. Two tests failed because Array.map skipped sparse holes; red log /tmp/firehose-court-notebook-sparse-red.log. Switched array parsing to Array.from to validate every position. All 28 tests now pass: /tmp/firehose-court-notebook-green.log.

Coverage: empty without write-on-load, trimmed text/exact identity roundtrip, copies/no retained caller references, corrupt JSON/future versions/unknown fields, size bounds, duplicate IDs, blank or wrongly typed identities, receipt payload prohibition, missing receipts/empty session ID, storage read/quota failures, failed mutation preservation, conflict/reload, invalid reload preservation.

Decision: strict validation rejects unknown fields rather than preserving or dropping possibly payload-bearing data. Character limits apply to trimmed manual text; IDs/source/session strings are bounded to 512 characters and preserved exactly. No-ID/source blanks rejected; session may be empty. Reads return last successfully loaded/saved snapshot; reload explicitly refreshes. Compare-and-write is optimistic best-effort, not a transaction.

A full TypeScript check at this point failed only because the parallel UI agent had not yet created ./ui/court imported by main.ts. No notebook-specific type errors were reported. Parent runs integrated gates once UI lands.
