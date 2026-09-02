// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";

import { createFeed } from "./feed";
import { FeedState } from "../state";
import type { FirehoseEvent } from "../api";

describe("feed rows", () => {
  test("label the workspace with what privacy allows and keep the full path in the title", () => {
    const feed = new FeedState(10);
    const digest = "aa43f1ff4abc3b9ab1e0a477140f68ea761e0384110aa530c6de08642f762655";
    feed.push({ id: "e1", time: new Date().toISOString(), source: "claude-code", category: "tool", summary: "ran Read", cwd: digest } as FirehoseEvent);
    feed.push({ id: "e2", time: new Date().toISOString(), source: "codex", category: "shell", summary: "ran ls", cwd: "/home/me/dev/app" } as FirehoseEvent);
    const panel = createFeed(feed, () => {});
    panel.refresh();
    const cwds = [...panel.root.querySelectorAll<HTMLElement>(".cell.cwd")];
    expect(cwds.map((c) => c.textContent)).toEqual(["aa43f1ff", "…/dev/app"]);
    expect(cwds[0].title).toBe(digest);
  });
});
