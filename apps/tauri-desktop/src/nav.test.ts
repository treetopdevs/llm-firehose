import { expect, test } from "vitest";
import { isAlias, resolveAlias } from "./nav";

const sc = { window: "live" } as const;

test("resolveAlias lands strata and ecosystem as Fleet host encodings", () => {
  expect(resolveAlias("strata", sc)).toEqual({ panel: "fleet", fleetEncoding: "strata" });
  expect(resolveAlias("ecosystem", { ...sc, project: "p" })).toEqual({ panel: "fleet", fleetEncoding: "ecosystem" });
});

test("resolveAlias lands workspace on the Project Graph chip", () => {
  expect(resolveAlias("workspace", sc)).toEqual({ panel: "project", encoding: "graph" });
});

test("isAlias recognises alias names only", () => {
  for (const n of ["live", "attention", "strata", "ecosystem", "workspace"]) expect(isAlias(n), n).toBe(true);
  for (const n of ["score", "fleet", "project", "nope"]) expect(isAlias(n), n).toBe(false);
});

test("resolveAlias live: Fleet Events, or Project Events when the project is registered", () => {
  const reg = (id: string) => id === "p";
  expect(resolveAlias("live", sc, reg)).toEqual({ panel: "fleet", fleetEncoding: "events" });
  expect(resolveAlias("live", { ...sc, project: "p" }, reg)).toEqual({ panel: "project", encoding: "events" });
  expect(resolveAlias("live", { ...sc, project: "ghost" }, reg)).toEqual({ panel: "fleet", fleetEncoding: "events" });
  expect(resolveAlias("live", { ...sc, project: "p", worktree: "w" }, reg)).toEqual({ panel: "project", encoding: "events" });
  expect(resolveAlias("live", { ...sc, worktree: "w" }, reg)).toEqual({ panel: "fleet", fleetEncoding: "events" });
  expect(resolveAlias("live", { ...sc, project: "p" })).toEqual({ panel: "fleet", fleetEncoding: "events" });
});

test("attention lands on the Worktree rung in Needs you mode and never clears scope", () => {
  for (const s of [sc, { ...sc, project: "p" }, { ...sc, project: "p", worktree: "w", session: { id: "x" } }]) {
    const land = resolveAlias("attention", s);
    expect(land).toEqual({ panel: "sessions", needsOnly: true });
    expect("clearContext" in land).toBe(false);
  }
});

test("every alias resolves to a landing", () => {
  for (const n of ["live", "attention", "strata", "ecosystem", "workspace"] as const) {
    expect(["fleet", "project", "sessions"]).toContain(resolveAlias(n, sc).panel);
  }
});
