// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { createScope } from "../../scope";
import { NOW } from "./model.fixtures";
import { createProject } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("404 through the real api client", () => {
  test("renders the unsupported banner", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("404 page not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const go = vi.fn();
    const panel = createProject({ store: createScope(), go, now: () => NOW });
    document.body.append(panel.root);
    await panel.activate();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/worktrees");
    expect(panel.root.querySelectorAll(".project-unsupported")).toHaveLength(1);
    expect(panel.root.querySelector(".project-unsupported")!.textContent).toContain("older daemon");
    expect(err).not.toHaveBeenCalled();
    panel.deactivate();
    err.mockRestore();
  });
});
