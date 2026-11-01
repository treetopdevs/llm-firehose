// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isEscapeClaimed, isEscapeEligible } from "../../escape";
import { createActions, type ActionsUi } from "./index";
import type { UnitAction } from "./model";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

const acts: UnitAction[] = [
  { id: "a", label: "Open in terminal", request: { type: "open", kind: "terminal", path: "/w/a" } },
  { id: "b", label: "Copy diff command", request: { type: "copy", text: "git diff" } },
  { id: "c", label: "Reveal in Finder", request: { type: "open", kind: "reveal", path: "/w/a" } },
];

let ui: ActionsUi;
let invoke: ReturnType<typeof vi.fn>;
let previewGate: { resolve: (v: unknown) => void } | undefined;

function make(preview?: () => Promise<unknown>) {
  invoke = vi.fn(async (cmd: string) => {
    if (cmd === "prune_preview") return preview ? preview() : {
      token: "t", root: "/repo", common_dir: "/repo/.git",
      entries: [{ id: "x", line: "Removing x", gitdir_path: "/gone/x" }, { id: "y", line: "Removing y", gitdir_path: null }],
      skipped: [{ id: "z", reason: "symlink" }],
    };
    if (cmd === "prune_apply") return { removed: ["x", "y"], remaining: [], skipped: [] };
    return undefined;
  });
  ui = createActions({ invoke, clipboard: { writeText: vi.fn(async () => {}) }, registerRoot: vi.fn(async () => {}), onChanged: vi.fn() });
  document.body.append(ui.root);
}
const key = (k: string, target: Element = document.activeElement ?? document.body) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const menu = () => document.querySelector<HTMLElement>("[role=menu].action-menu");
const items = () => [...document.querySelectorAll<HTMLButtonElement>("button[role=menuitem]")];
const dialog = () => document.querySelector<HTMLElement>("[role=dialog][aria-modal=true]");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { document.body.innerHTML = ""; previewGate = undefined; });
afterEach(() => { vi.useRealTimers(); });

describe("menu", () => {
  test("renders items, focuses first", () => {
    make();
    ui.openMenu(acts, { x: 5, y: 5 });
    expect(items().map((b) => b.textContent)).toEqual(acts.map((a) => a.label));
    expect(document.activeElement).toBe(items()[0]);
    expect(isEscapeEligible(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
  });
  test("empty list shows info, no menu", () => {
    make();
    ui.openMenu([], { x: 0, y: 0 });
    expect(menu()).toBeNull();
    expect(document.querySelector(".action-toast")!.textContent).toBe("No actions for this item");
  });
  test("click runs once and closes", async () => {
    make();
    ui.openMenu(acts, { x: 0, y: 0 });
    items()[0].click();
    await flush();
    expect(menu()).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("open_path", { kind: "terminal", path: "/w/a" });
  });
  test("arrows wrap, Enter activates", async () => {
    make();
    ui.openMenu(acts, { x: 0, y: 0 });
    key("ArrowUp");
    expect(document.activeElement).toBe(items()[2]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(menu()).toBeNull();
    expect(document.querySelector(".action-toast")!.textContent).toBe("Copied diff command");
  });
  test("Escape closes, restores focus, claims", () => {
    make();
    const rf = document.createElement("button");
    document.body.append(rf);
    ui.openMenu(acts, { x: 0, y: 0 }, { returnFocus: rf });
    const e = key("Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(rf);
    expect(isEscapeClaimed(e)).toBe(true);
  });
  test("Tab and outside pointerdown close; second open replaces", () => {
    make();
    ui.openMenu(acts, { x: 0, y: 0 });
    key("Tab");
    expect(menu()).toBeNull();
    ui.openMenu(acts, { x: 0, y: 0 });
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
    ui.openMenu(acts, { x: 0, y: 0 });
    ui.openMenu(acts.slice(0, 1), { x: 0, y: 0 });
    expect(document.querySelectorAll(".action-menu")).toHaveLength(1);
    expect(items()).toHaveLength(1);
  });
  test("position is clamped to window", () => {
    make();
    ui.openMenu(acts, { x: 99999, y: -50 });
    expect(parseFloat(menu()!.style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(menu()!.style.top)).toBe(0);
  });
  test("captured immutably", () => {
    make();
    const src = acts.map((a) => ({ ...a, request: { ...a.request } })) as UnitAction[];
    ui.openMenu(src, { x: 0, y: 0 });
    src[0].label = "HACKED";
    (src[0].request as { path: string }).path = "/evil";
    src.length = 0;
    expect(items()).toHaveLength(3);
    expect(items()[0].textContent).toBe("Open in terminal");
    items()[0].click();
    expect(invoke).toHaveBeenCalledWith("open_path", { kind: "terminal", path: "/w/a" });
  });
});

describe("prune dialog", () => {
  const prune = () => ui.run({ type: "prune", root: "/repo" });
  test("content and confirm", async () => {
    make();
    const p = prune();
    await flush();
    const d = dialog()!;
    expect(d.textContent).toContain("/repo");
    expect(d.textContent).toContain("/repo/.git");
    expect(d.querySelector("pre")!.textContent).toBe("x  /gone/x\ny");
    expect(d.textContent).toContain("z: symlink");
    expect(d.textContent).toContain("only git's administrative records under .git/worktrees");
    expect(d.textContent).toContain("never deletes branches or working directories");
    expect(d.textContent).toContain("git worktree lock");
    expect(d.querySelector(".action-dialog-ok")!.textContent).toBe("Prune 2 stale entries");
    expect(document.activeElement!.textContent).toBe("Cancel");
    d.querySelector<HTMLButtonElement>(".action-dialog-ok")!.click();
    await p;
    expect(dialog()).toBeNull();
    expect(invoke).toHaveBeenCalledWith("prune_apply", { root: "/repo", token: "t" });
  });
  test.each(["cancel", "escape", "backdrop"])("%s resolves false", async (how) => {
    make();
    const p = prune();
    await flush();
    const d = dialog()!;
    if (how === "cancel") d.querySelector<HTMLButtonElement>(".action-dialog-cancel")!.click();
    else if (how === "escape") expect(isEscapeClaimed(key("Escape"))).toBe(true);
    else d.click();
    await p;
    expect(dialog()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("prune_apply", expect.anything());
    expect(document.querySelector(".action-toast")!.textContent).toBe("Prune cancelled");
  });
});

describe("single instance and cancel", () => {
  test("one root; cancelAll closes menu", () => {
    make();
    expect(document.querySelectorAll(".actions-host")).toHaveLength(1);
    ui.openMenu(acts, { x: 0, y: 0 });
    ui.cancelAll();
    expect(menu()).toBeNull();
  });
  test("cancelAll resolves pending dialog false", async () => {
    make();
    const p = ui.run({ type: "prune", root: "/repo" });
    await flush();
    expect(dialog()).not.toBeNull();
    ui.cancelAll();
    await p;
    expect(dialog()).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("prune_apply", expect.anything());
  });
  test("cancelAll during preview discards late result", async () => {
    let release!: (v: unknown) => void;
    make(() => new Promise((r) => { release = r; }));
    const p = ui.run({ type: "prune", root: "/repo" });
    await flush();
    ui.cancelAll();
    release({ token: "t", root: "/repo", common_dir: "/repo/.git", entries: [{ id: "x", line: "l" }], skipped: [] });
    await p;
    expect(dialog()).toBeNull();
  });
});

describe("toast", () => {
  test("classes and timings", async () => {
    vi.useFakeTimers();
    make();
    const t = () => document.querySelector<HTMLElement>("[role=status].action-toast")!;
    await ui.run({ type: "open", kind: "editor", path: "/w/a" });
    expect(t().classList.contains("ok")).toBe(true);
    vi.advanceTimersByTime(3999);
    expect(t().textContent).not.toBe("");
    vi.advanceTimersByTime(1);
    expect(t().textContent).toBe("");
    invoke.mockRejectedValueOnce("boom");
    await ui.run({ type: "open", kind: "editor", path: "/w/a" });
    expect(t().classList.contains("error")).toBe(true);
    expect(t().textContent).toBe("boom");
    vi.advanceTimersByTime(7999);
    expect(t().textContent).toBe("boom");
    vi.advanceTimersByTime(1);
    expect(t().textContent).toBe("");
    ui.openMenu([], { x: 0, y: 0 });
    expect(t().classList.contains("info")).toBe(true);
  });
});
