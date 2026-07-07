import { describe, expect, test } from "vitest";
import { FeedState, coalesce } from "./state";
import type { FirehoseEvent } from "./api";

function ev(partial: Partial<FirehoseEvent> & { id: string }): FirehoseEvent {
  return {
    time: "2026-07-02T10:00:00Z",
    source: "claude-code",
    category: "tool",
    ...partial,
  } as FirehoseEvent;
}

describe("coalesce", () => {
  test("groups consecutive same-shape events within the window", () => {
    const rows = coalesce(
      [
        ev({ id: "1", session_id: "s1", name: "Edit", time: "2026-07-02T10:00:00Z" }),
        ev({ id: "2", session_id: "s1", name: "Edit", time: "2026-07-02T10:00:01Z" }),
        ev({ id: "3", session_id: "s1", name: "Edit", time: "2026-07-02T10:00:02Z" }),
      ],
      2000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].event.id).toBe("3"); // latest event represents the group
  });

  test("different name breaks the group", () => {
    const rows = coalesce(
      [
        ev({ id: "1", session_id: "s1", name: "Edit" }),
        ev({ id: "2", session_id: "s1", name: "Bash" }),
      ],
      2000,
    );
    expect(rows).toHaveLength(2);
  });

  test("a gap wider than the window breaks the group", () => {
    const rows = coalesce(
      [
        ev({ id: "1", session_id: "s1", name: "Edit", time: "2026-07-02T10:00:00Z" }),
        ev({ id: "2", session_id: "s1", name: "Edit", time: "2026-07-02T10:00:10Z" }),
      ],
      2000,
    );
    expect(rows).toHaveLength(2);
  });
});

describe("FeedState", () => {
  test("bounded buffer drops oldest", () => {
    const feed = new FeedState(3);
    for (let i = 0; i < 5; i++) {
      feed.push(ev({ id: `e${i}`, name: `n${i}` }));
    }
    const rows = feed.rows();
    expect(rows).toHaveLength(3);
    expect(rows[0].event.id).toBe("e2");
    expect(rows[2].event.id).toBe("e4");
  });

  test("category and source filters", () => {
    const feed = new FeedState(100);
    feed.push(ev({ id: "1", category: "tool" }));
    feed.push(ev({ id: "2", category: "file", name: "a" }));
    feed.push(ev({ id: "3", category: "file", source: "codex", name: "b" }));

    feed.setFilter({ category: "file" });
    expect(feed.rows()).toHaveLength(2);

    feed.setFilter({ category: "file", source: "codex" });
    expect(feed.rows()).toHaveLength(1);
    expect(feed.rows()[0].event.id).toBe("3");

    feed.setFilter({});
    expect(feed.rows()).toHaveLength(3);
  });

  test("text filter matches summary case-insensitively", () => {
    const feed = new FeedState(100);
    feed.push(ev({ id: "1", summary: "ran GO TEST ./...", name: "a" }));
    feed.push(ev({ id: "2", summary: "edited main.ts", name: "b" }));
    feed.setFilter({ text: "go test" });
    const rows = feed.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event.id).toBe("1");
  });

  test("pause freezes rows and counts unread; resume catches up", () => {
    const feed = new FeedState(100);
    feed.push(ev({ id: "1", name: "a" }));
    feed.pause();
    feed.push(ev({ id: "2", name: "b" }));
    feed.push(ev({ id: "3", name: "c" }));

    expect(feed.paused).toBe(true);
    expect(feed.unread).toBe(2);
    expect(feed.rows()).toHaveLength(1); // frozen at pause time

    feed.resume();
    expect(feed.paused).toBe(false);
    expect(feed.unread).toBe(0);
    expect(feed.rows()).toHaveLength(3);
  });

  test("tracks distinct sources in arrival order", () => {
    const feed = new FeedState(100);
    feed.push(ev({ id: "1", source: "claude-code", name: "a" }));
    feed.push(ev({ id: "2", source: "codex", name: "b" }));
    feed.push(ev({ id: "3", source: "claude-code", name: "c" }));
    expect(feed.sources()).toEqual(["claude-code", "codex"]);
  });
});
