// Where the user has been (MS-8). A place is a panel, its view (encoding or tab) and what is
// in scope; the time range is not part of it, so changing the range never adds an entry.
// Back and forward walk the entries. Scroll position is remembered per place, not per entry,
// so returning by Back, by Escape or by the sidebar all land where the user left off.

export interface Place {
  readonly panel: string;
  readonly view?: string;
  readonly project?: string;
  readonly worktree?: string;
  readonly session?: { readonly id: string; readonly source?: string };
}

export const placeKey = (p: Place): string =>
  JSON.stringify([p.panel, p.view ?? "", p.project ?? "", p.worktree ?? "", p.session?.id ?? "", p.session?.source ?? ""]);

export const samePlace = (a: Place, b: Place): boolean => placeKey(a) === placeKey(b);

export interface Entry<S> {
  place: Place;
  state: S;
}

/** One scrolled element: found again by its first class (empty for the root itself). */
export interface ScrollMark {
  sel: string;
  top: number;
  /** The first visible keyed row, and how far its top sat from the scroller's top. */
  key?: string;
  offset?: number;
}

export interface History<S> {
  /** Push a new place (dropping any forward entries) or update the state of the current one. True when pushed. */
  record(place: Place, state: S): boolean;
  back(): Entry<S> | undefined;
  forward(): Entry<S> | undefined;
  current(): Entry<S> | undefined;
  canBack(): boolean;
  canForward(): boolean;
  remember(place: Place, marks: ScrollMark[]): void;
  recall(place: Place): ScrollMark[] | undefined;
}

export function createHistory<S>(cap = 50): History<S> {
  let entries: Entry<S>[] = [];
  let at = -1;
  const scroll = new Map<string, ScrollMark[]>();
  return {
    record(place, state) {
      const cur = entries[at];
      if (cur && samePlace(cur.place, place)) {
        cur.state = state;
        return false;
      }
      entries = entries.slice(0, at + 1);
      entries.push({ place, state });
      if (entries.length > cap) entries = entries.slice(entries.length - cap);
      at = entries.length - 1;
      return true;
    },
    back() {
      if (at <= 0) return undefined;
      at--;
      return { ...entries[at] };
    },
    forward() {
      if (at >= entries.length - 1) return undefined;
      at++;
      return { ...entries[at] };
    },
    current: () => (at >= 0 ? { ...entries[at] } : undefined),
    canBack: () => at > 0,
    canForward: () => at < entries.length - 1,
    remember(place, marks) {
      if (marks.length === 0) scroll.delete(placeKey(place));
      else scroll.set(placeKey(place), marks);
    },
    recall: (place) => scroll.get(placeKey(place)),
  };
}

const firstClass = (el: Element): string => {
  const c = el.getAttribute("class")?.trim().split(/\s+/)[0];
  return c ? "." + c : "";
};

/** The mark for one scroller, or undefined when it is at the top or cannot be found again. */
export function markOf(root: Element, el: Element): ScrollMark | undefined {
  if (!(el.scrollTop > 0)) return undefined;
  const sel = el === root ? "" : firstClass(el);
  if (el !== root && !sel) return undefined;
  const mark: ScrollMark = { sel, top: el.scrollTop };
  const edge = el.getBoundingClientRect().top;
  for (const row of el.querySelectorAll("[data-key]")) {
    const r = row.getBoundingClientRect();
    if (r.bottom > edge) {
      const key = row.getAttribute("data-key");
      if (key !== null) {
        mark.key = key;
        mark.offset = r.top - edge;
      }
      break;
    }
  }
  return mark;
}

/** The scrolled elements under (and including) root. Lists are live, so each is anchored to its first visible keyed row. */
export function captureScroll(root: Element): ScrollMark[] {
  const out: ScrollMark[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const m = markOf(root, el);
    if (m) out.push(m);
  }
  return out;
}

export interface RestoreOpts {
  /** How many animation frames to keep trying while the view loads (default 90, about 1.5 s). */
  frames?: number;
  raf?: (fn: () => void) => number;
}

/** Puts each mark back, by keyed row when it exists, else by pixel once the content is tall enough. Returns a cancel. */
export function restoreScroll(root: Element, marks: ScrollMark[], opts: RestoreOpts = {}): () => void {
  let left = opts.frames ?? 90;
  let cancelled = false;
  const raf = opts.raf ?? ((fn: () => void) => requestAnimationFrame(fn));
  let pending = marks.slice();
  const attempt = (): void => {
    if (cancelled) return;
    pending = pending.filter((m) => {
      const el = m.sel ? root.querySelector(m.sel) : root;
      if (!el) return true;
      if (m.key !== undefined) {
        const row = [...el.querySelectorAll("[data-key]")].find((n) => n.getAttribute("data-key") === m.key);
        if (row) {
          el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - (m.offset ?? 0);
          return false;
        }
      }
      if (el.scrollHeight - el.clientHeight >= m.top) {
        el.scrollTop = m.top;
        return false;
      }
      return true;
    });
    if (pending.length > 0 && left-- > 0) raf(attempt);
  };
  attempt();
  return () => {
    cancelled = true;
  };
}
