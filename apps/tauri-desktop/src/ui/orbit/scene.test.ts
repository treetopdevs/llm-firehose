import { describe, expect, test } from "vitest";
import type { OrbitBody } from "./model";
import { isRenderableBody } from "./scene";

function body(over: Partial<OrbitBody> = {}): OrbitBody {
  return {
    sessionId: "s1",
    family: "claude-code",
    repo: "repo",
    state: "working",
    urgencyRadius: 0.9,
    sectorAngle: 0,
    activityRate: 0.5,
    hasError: false,
    labelAlways: false,
    kind: "session",
    ...over,
  };
}

describe("isRenderableBody", () => {
  test("accepts finite body geometry", () => {
    expect(isRenderableBody(body())).toBe(true);
  });

  test("rejects bodies that would poison the WebGL scene", () => {
    expect(isRenderableBody(body({ sessionId: "" }))).toBe(false);
    expect(isRenderableBody(body({ urgencyRadius: Number.NaN }))).toBe(false);
    expect(isRenderableBody(body({ urgencyRadius: -1 }))).toBe(false);
    expect(isRenderableBody(body({ sectorAngle: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isRenderableBody(body({ activityRate: Number.NEGATIVE_INFINITY }))).toBe(false);
  });
});
