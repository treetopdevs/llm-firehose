**PASS**

- [`show`](../../apps/tauri-desktop/src/main.ts#L116-L127) in [main.ts](../../apps/tauri-desktop/src/main.ts#L118) now calls `renderDetail(detailPane, null, () => {})` when entering `loom`, which both empties `detailPane` and removes the `.open` class (consistent with the existing close handlers at lines 38 and 48), while `clear` remains used for `clear(content)` on line 123.
- [main.test.ts](../../apps/tauri-desktop/src/main.test.ts#L120-L141) adds the regression test verifying that an open, populated `.detail` pane has `.open` removed and `childElementCount === 0` upon navigating to `loom` (`4/4` tests passing).
