import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Plan 007: every source+id session key goes through sessionRefKey, never a hand-built `${x}${SEP}${id}`.
describe("fleet session keys", () => {
  for (const f of ["encodings.ts", "index.ts"]) {
    it(`${f} builds no source+SEP+id keys by hand`, () => {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/(source|origin)\}\$\{SEP\}/);
    });
  }
});
