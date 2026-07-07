import { describe, expect, test } from "vitest";
import { checkCompat } from "./compat";

describe("checkCompat", () => {
  test("same schema version is compatible", () => {
    const c = checkCompat({ status: "ok", version: "0.1.0", schema_version: 1 }, 1);
    expect(c.compatible).toBe(true);
  });

  test("newer daemon schema blocks with a message naming both versions", () => {
    const c = checkCompat({ status: "ok", version: "9.9.9", schema_version: 2 }, 1);
    expect(c.compatible).toBe(false);
    expect(c.reason).toContain("2");
    expect(c.reason).toContain("1");
  });

  test("older daemon schema also blocks (client must not assume forward compat)", () => {
    const c = checkCompat({ status: "ok", version: "0.0.1", schema_version: 1 }, 2);
    expect(c.compatible).toBe(false);
  });

  test("missing schema version is treated as v1 (pre-versioning daemons)", () => {
    const c = checkCompat({ status: "ok", version: "0.0.1", schema_version: 0 }, 1);
    expect(c.compatible).toBe(true);
  });
});
