import { describe, expect, test } from "vitest";
import table from "./liveness.cases.json";
import { lastReported, stateFresh } from "./spark";

const ms = (iso: string): number => (iso === "" ? NaN : Date.parse(iso));

describe("liveness case table shared with internal/tui", () => {
  const now = Date.parse(table.now);
  for (const c of table.cases) {
    test(c.name, () => {
      const state = c.state === "" ? undefined : c.state;
      expect(stateFresh(state, lastReported(ms(c.last), ms(c.since), state), now)).toBe(c.ts);
    });
  }
});
