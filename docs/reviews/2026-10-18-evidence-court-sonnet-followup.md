# Sonnet follow-up review

**PASS** for `d1455bc` against `7396758`. I found no blocking findings. I read the diff and surrounding code but did not run the tests, so the claimed "42 tests passed" is unverified.

**What I checked**
- **Mismatch copy** ([index.ts](apps/tauri-desktop/src/ui/court/index.ts#L120)): the `identity mismatch` branch now depends on `saved`.
  - A new lookup (`saved` undefined) says "Returned evidence does not match the requested event. Nothing attached." That is accurate, because the Attach button is only added when `!saved` after a successful verification (line 113). A mismatch throws first, so nothing is attached.
  - A saved receipt keeps the old wording: "conflicts with the saved identity… inspect or remove it." That is correct, because the saved reference is retained.
  - The regex match is unchanged. Both error strings (`Evidence identity mismatch` at line 109, `Receipt identity mismatch` at line 111) still match it. Line 111 only runs when `saved` is set, so the wording is consistent for both.
  - The non-mismatch "Evidence unavailable" branch is untouched.
- **Regression test** ([index.test.ts](apps/tauri-desktop/src/ui/court/index.test.ts#L27)): the new-lookup mismatch now asserts `Nothing attached.` and the absence of `inspect or remove`.
  - The saved-receipt path is covered at line 39 with `Receipt identity mismatch` and `Receipt attached — not verified`.
  - Unchanged lines in the same test still cover the missing gap and the storage-failure recovery.
- **`STORAGE_KEY`**: it is exported at [notebook.ts:2](apps/tauri-desktop/src/ui/court/notebook.ts#L2) with the identical value `firehose.evidence-court.v1`. The import is a named import with no cycle. No hardcoded copy of the key remains in `src`, and `notebook.test.ts` already uses the export.
- **Scope**: only `index.ts`, `index.test.ts`, one planning HTML line, and a validation-doc paragraph changed. There are no behavior changes outside the copy and the key reuse.

**Non-blocking nits (no action needed)**
1. The saved-receipt mismatch wording ("conflicts with the saved identity… inspect or remove it") is not asserted. Line 39 checks only the `Receipt identity mismatch` heading text and the status. Add an assertion if you want that copy guarded against regressions.
2. The new test line is packed onto one line like the rest of the file, so it is dense but consistent.
3. The doc entry says "Autofix requested… service required credits/billing". That is a process note, not a code claim.

No remaining findings.
