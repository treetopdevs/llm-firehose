// Agent Firehose site script. Three small, independent parts: copy buttons,
// the recorder trace in the margin, and the terminal demo. The page is
// complete without any of them; everything here is enhancement.
(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- copy buttons ----------

  for (const btn of document.querySelectorAll("[data-copy]")) {
    const idle = btn.textContent;
    let timer = 0;
    btn.addEventListener("click", async () => {
      let ok = false;
      try {
        // A clipboard write can hang behind a permission prompt; give up
        // after a second and fall back to selecting the text.
        await Promise.race([
          navigator.clipboard.writeText(btn.dataset.copy),
          new Promise((_, reject) => setTimeout(reject, 1000)),
        ]);
        ok = true;
      } catch {
        // Clipboard access can be refused; select the command so the
        // reader can copy it by hand.
        const target = document.getElementById(btn.dataset.target);
        if (target) {
          const range = document.createRange();
          range.selectNodeContents(target);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      btn.dataset.state = ok ? "copied" : "failed";
      btn.textContent = ok ? "Copied" : "Selected";
      clearTimeout(timer);
      timer = setTimeout(() => {
        btn.textContent = idle;
        delete btn.dataset.state;
      }, 1800);
    });
  }

  // ---------- recorder trace ----------

  const strip = document.querySelector(".strip");
  const tracePath = strip && strip.querySelector(".trace path");

  // mulberry32: a fixed seed keeps the trace identical on every visit.
  function rng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function drawTrace() {
    if (!tracePath) return;
    const box = strip.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    const svg = tracePath.ownerSVGElement;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const mid = w / 2;
    const reach = w * 0.4;
    // Each section stamp is an event on the roll: a burst that decays.
    const pulses = [...document.querySelectorAll("[data-pulse]")].map((el) => ({
      y: el.getBoundingClientRect().top - box.top + 8,
      gain: Number(el.dataset.pulse),
      len: Number(el.dataset.pulseLen || 150),
    }));
    const rand = rng(4517);
    const step = 3;
    let d = `M${mid.toFixed(1)} 0`;
    let side = 1;
    for (let y = step; y <= h; y += step) {
      let amp = 0.9;
      for (const p of pulses) {
        const dy = y - p.y;
        if (dy < -4) continue;
        amp += p.gain * reach * Math.exp(-Math.max(dy, 0) / p.len) * (dy < 0 ? 0.4 : 1);
      }
      side = -side;
      const x = mid + side * Math.min(amp, reach) * (0.35 + 0.65 * rand());
      d += `L${x.toFixed(1)} ${y}`;
    }
    tracePath.setAttribute("d", d);
    // The pen starts a little way down the first screen, then follows scroll.
    const start = Math.min(0.9, (0.62 * window.innerHeight) / h);
    svg.style.setProperty("--pen-start", start.toFixed(4));
  }

  if (tracePath) {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(drawTrace);
    };
    new ResizeObserver(schedule).observe(strip);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    schedule();
  }

  // ---------- altitudes viewer ----------
  // One terminal that moves between the three views. The static ladder in
  // the markup is the no-script version; this replaces it. No timers: the
  // viewer only changes when the reader acts.

  const escHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  (function viewer() {
    const root = document.querySelector("[data-viewer]");
    const ladder = document.querySelector(".ladder");
    if (!root || !ladder) return;
    const screen = root.querySelector("[data-screen]");
    const note = root.querySelector("[data-note]");
    const status = root.querySelector("[data-status]");
    const up = root.querySelector("[data-up]");
    const down = root.querySelector("[data-down]");
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const texts = [...ladder.querySelectorAll(".rung-text")];
    if (!screen || !note || !status || !up || !down || tabs.length !== 3 || texts.length !== 3) return;

    // Invented fixture sessions, one per matrix cell, in reading order.
    // The call view follows the real one. Claude Code hooks report both ends
    // of a tool call, so those rows pair start with end. The Codex rollout
    // reports the end only ("no start captured"). OpenCode sends one event
    // with no phase, so it shows a plain payload table and no timing rows.
    const CELLS = [
      {
        ws: "…/dev/app", agent: "codex", cls: "s-x", col: 1, glyph: "●", sid: "fixture-app",
        spark: [2, 4, 6, 8, 4, 2, 0, 2, 4, 0],
        rows: [
          { at: "10:04:19.412", g: "■", cat: "file", tool: "apply_patch", t: "patched auth.go, session.go", call: "call-0017", res: { status: "success" } },
          { at: "10:04:27.218", g: "$", cat: "shell", tool: "exec_command", t: "ran: go test ./...", call: "call-0018", res: { command: "go test ./...", exit_code: 1, status: "error" } },
          { at: "10:04:32.640", g: "!", tone: "err", cat: "file", tool: "apply_patch", t: "patch failed", call: "call-0019", res: { status: "error" } },
          { at: "10:04:48.075", g: "■", cat: "file", tool: "apply_patch", t: "patched auth.go", n: 2, call: "call-0021", res: { status: "success" } },
        ],
      },
      {
        ws: "…/dev/api", agent: "claude", cls: "s-c", col: 0, glyph: "●", count: 2, sid: "fixture-api",
        spark: [0, 2, 2, 4, 2, 2, 0, 4, 6, 2],
        rows: [
          { at: "10:04:19.106", g: "■", cat: "file", tool: "Edit", t: "ran Edit on router.go", call: "call-0041", end: "10:04:19.164", dur: "58ms", req: { status: "started" }, res: { status: "success" } },
          { at: "10:04:27.218", g: "$", cat: "shell", tool: "Bash", t: "ran shell tool: git commit", call: "call-0042", end: "10:04:31.902", dur: "4.68s", req: { status: "started" }, res: { status: "success" } },
          { at: "10:04:36.530", g: "●", cat: "tool", tool: "Grep", t: "ran tool Grep", call: "call-0043", end: "10:04:36.611", dur: "81ms", req: { status: "started" }, res: { status: "success" } },
          { at: "10:04:48.300", g: "■", cat: "file", tool: "Edit", t: "ran Edit on router_test.go", n: 2, call: "call-0045", end: "10:04:48.371", dur: "71ms", req: { status: "started" }, res: { status: "success" } },
        ],
      },
      {
        ws: "…/dev/web", agent: "opencode", cls: "s-o", col: 2, glyph: "?", needs: true, sid: "fixture-web",
        spark: [2, 2, 0, 0, 4, 2, 0, 0, 0, 8],
        rows: [
          { at: "10:04:11.020", g: "$", cat: "shell", tool: "bash", t: "ran shell tool", call: "call-0007", payload: { duration_ms: 1840, exit_code: 0, status: "completed" } },
          { at: "10:04:19.377", g: "■", cat: "file", tool: "edit", t: "edited index.html", n: 12, call: "call-0008", payload: { duration_ms: 12, status: "completed" } },
          { at: "10:04:25.901", g: "●", cat: "tool", tool: "read", t: "tool: read", call: "call-0009", payload: { duration_ms: 4, status: "completed" } },
          { at: "10:04:33.455", g: "?", tone: "needs", cat: "permission", t: "permission requested", payload: { permission_type: "bash" } },
        ],
      },
    ];
    const WORKSPACES = ["…/dev/app", "…/dev/api", "…/dev/web"];
    const AGENTS = ["claude", "codex", "opencode"];

    const state = { level: 0, cell: 1, row: 1 };

    // All three descriptions share one grid cell, so the tallest sets the
    // height and switching never moves the page.
    const notes = texts.map((text) => {
      const div = document.createElement("div");
      div.append(...[...text.querySelectorAll("p")].map((p) => p.cloneNode(true)));
      return div;
    });
    note.replaceChildren(...notes);

    const spark = (v) => '<span class="spark">' + v.map((n) => '<i style="--h:' + n + '"></i>').join("") + "</span>";
    const kv = (title, obj) => {
      const keys = Object.keys(obj).sort();
      return (
        '<p class="kv-title">' + title + '</p><dl class="kv">' +
        keys.map((k) => "<dt>" + escHtml(k) + "</dt><dd>" + escHtml(obj[k]) + "</dd>").join("") +
        "</dl>"
      );
    };

    function workspaceView() {
      let grid = "<span></span>" + AGENTS.map((a) => '<span class="dim">' + a + "</span>").join("");
      WORKSPACES.forEach((ws) => {
        grid += "<span>" + ws + "</span>";
        AGENTS.forEach((_, col) => {
          const i = CELLS.findIndex((c) => c.ws === ws && c.col === col);
          if (i < 0) {
            grid += "<span></span>";
            return;
          }
          const c = CELLS[i];
          grid +=
            '<span class="cell' + (i === state.cell ? " is-sel" : "") + '" data-pick="' + i + '">' +
            spark(c.spark) + '<i class="g' + (c.needs ? " needs" : "") + '">' + c.glyph + "</i>" +
            (c.count ? '<span class="n">' + c.count + "</span>" : "") + "</span>";
        });
      });
      return (
        '<p class="tui-head"><b>AGENT FIREHOSE</b> <span class="live">● LIVE</span> <span class="dim">workspace</span></p>' +
        '<div class="matrix">' + grid + "</div>" +
        '<p class="tui-foot">? help · ↑↓ pick · enter open</p>'
      );
    }

    function sessionView() {
      const c = CELLS[state.cell];
      const rows = c.rows
        .map((r, i) => {
          const clock = i === 0 ? r.at.slice(0, 8) : r.at.slice(5, 8);
          return (
            "<li" + (i === state.row ? ' class="is-sel"' : "") + ' data-pick="' + i + '">' +
            '<span class="clk">' + clock + '</span><span class="sbar ' + c.cls + '">│</span>' +
            '<span class="agent">' + c.agent + "</span>" +
            '<span class="ev"><i class="g' + (r.tone ? " " + r.tone : "") + '">' + r.g + "</i>" + escHtml(r.t) +
            (r.n ? ' <span class="dim">×' + r.n + "</span>" : "") + "</span>" +
            '<span class="ws">' + (i === 0 ? c.ws : "") + "</span></li>"
          );
        })
        .join("");
      return (
        '<p class="tui-head"><b>AGENT FIREHOSE</b> <span class="live">● LIVE</span> <span class="dim">▸</span> ' +
        c.ws + " · " + c.agent + "</p>" +
        '<ol class="feed">' + rows + "</ol>" +
        '<p class="tui-foot">? help · ↑↓ pick · enter open · esc workspace</p>'
      );
    }

    function callView() {
      const c = CELLS[state.cell];
      const r = c.rows[state.row];
      let rowsHtml = "";
      const add = (k, v) => (rowsHtml += "<dt>" + k + "</dt><dd>" + v + "</dd>");
      if (r.end) {
        add("started", r.at);
        add("ended", r.end + ' <span class="dim">' + r.dur + "</span>");
      } else if (r.res) {
        add("ended", r.at + ' <span class="dim">no start captured</span>');
      }
      add("ids", "session " + c.sid + (r.call ? " · call " + r.call : ""));
      return (
        '<p class="tui-head"><b>CALL</b> <span class="dim">' + c.ws + " · " + c.agent + "  (esc to close)</span></p>" +
        '<p class="call-title"><span class="dim">' + r.at + '</span> <i class="g' + (r.tone ? " " + r.tone : "") + '">' +
        r.g + "</i> " + r.cat + (r.tool ? "  " + r.tool : "") + "</p>" +
        '<p class="call-sum">' + escHtml(r.t) + "</p>" +
        '<dl class="kv">' + rowsHtml + "</dl>" +
        (r.req ? kv("request", r.req) : "") +
        (r.res ? kv("response", r.res) : "") +
        (r.payload ? kv("payload", r.payload) : "") +
        '<p class="tui-foot">? help · esc session</p>'
      );
    }

    function render(announce) {
      const c = CELLS[state.cell];
      screen.innerHTML = [workspaceView, sessionView, callView][state.level]();
      screen.dataset.level = state.level;
      screen.setAttribute("aria-labelledby", tabs[state.level].id);
      tabs.forEach((tab, i) => {
        const on = i === state.level;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
      });
      notes.forEach((n, i) => n.classList.toggle("is-on", i === state.level));
      up.disabled = state.level === 0;
      down.disabled = state.level === 2;
      if (announce) {
        const where = c.ws + " " + c.agent;
        status.textContent =
          state.level === 0
            ? "Workspace view. " + where + " selected."
            : state.level === 1
              ? "Session view, " + where + ". Row " + (state.row + 1) + " of " + c.rows.length + ": " + c.rows[state.row].t + "."
              : "Call view. " + c.rows[state.row].t + ".";
      }
    }

    function go(level) {
      state.level = Math.max(0, Math.min(2, level));
      render(true);
    }

    function move(step) {
      if (state.level === 0) {
        state.cell = (state.cell + step + CELLS.length) % CELLS.length;
        state.row = 1;
      } else if (state.level === 1) {
        const n = CELLS[state.cell].rows.length;
        state.row = Math.max(0, Math.min(n - 1, state.row + step));
      } else {
        return false;
      }
      render(true);
      return true;
    }

    // Keys act only while the terminal itself has focus, so Tab still
    // leaves and nothing is taken from the rest of the page.
    screen.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let used = false;
      if (e.key === "Enter") {
        used = state.level < 2;
        if (used) go(state.level + 1);
      } else if (e.key === "Escape") {
        used = state.level > 0;
        if (used) go(state.level - 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "k") {
        used = move(-1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "j") {
        used = move(1);
      }
      if (used) e.preventDefault();
    });

    // A click or tap picks the cell or row and descends into it.
    screen.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-pick]");
      if (!hit || state.level > 1) return;
      const i = Number(hit.dataset.pick);
      if (state.level === 0) {
        state.cell = i;
        state.row = 1;
      } else {
        state.row = i;
      }
      go(state.level + 1);
      screen.focus({ preventScroll: true });
    });

    // A button that reaches the end of the ladder disables itself; hand
    // focus to the screen so a keyboard reader is not dropped to the page.
    for (const [btn, step] of [[up, -1], [down, 1]]) {
      btn.addEventListener("click", () => {
        go(state.level + step);
        if (btn.disabled) screen.focus({ preventScroll: true });
      });
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => go(i));
      tab.addEventListener("keydown", (e) => {
        let to = -1;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") to = (i + 1) % tabs.length;
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") to = (i + tabs.length - 1) % tabs.length;
        else if (e.key === "Home") to = 0;
        else if (e.key === "End") to = tabs.length - 1;
        if (to < 0) return;
        e.preventDefault();
        go(to);
        tabs[to].focus();
      });
    });

    render(false);
    ladder.hidden = true;
    root.hidden = false;
  })();

  // ---------- terminal demo ----------

  const demo = document.getElementById("demo");
  if (!demo) return;
  const headEl = demo.querySelector("[data-head]");
  const bandEl = demo.querySelector("[data-band]");
  const feedEl = demo.querySelector("[data-feed]");
  const toggle = demo.querySelector("[data-toggle]");
  if (!headEl || !bandEl || !feedEl || !toggle) return;

  const FEED_ROWS = 9;
  const BUCKETS = 10; // sparkline: events per 30s over the last 5m
  const BUCKET_S = 30;
  const DWELL_MAX = 600; // dwell bar is full at 10m, hairline at 5m

  const sessions = {
    x: { agent: "codex", ws: "…/dev/app", cls: "s-x" },
    c: { agent: "claude", ws: "…/dev/api", cls: "s-c" },
    o: { agent: "opencode", ws: "…/dev/web", cls: "s-o" },
  };
  for (const s of Object.values(sessions)) {
    Object.assign(s, { state: "idle", since: 0, did: "", reason: "", times: [] });
  }

  // Invented fixture events, looped. Summaries follow the wording each
  // adapter really emits (Claude Code hooks are metadata-only; the Codex
  // rollout tail carries commands and file names). dt is seconds since the
  // previous event.
  // A `set` entry changes the session's state as the engine would report it.
  const SCRIPT = [
    { dt: 3, s: "x", g: "▸", t: 'prompt: "fix the login bug"', set: "working" },
    { dt: 3, s: "x", g: "$", t: "ran: go test ./..." },
    { dt: 4, s: "c", g: "■", t: "ran Edit on router.go" },
    { dt: 2, s: "x", g: "■", t: "patched auth.go, session.go" },
    { dt: 6, s: "c", g: "$", t: "ran shell tool" },
    { dt: 5, s: "c", g: "!", t: "agent response failed", tone: "err" },
    { dt: 7, s: "x", g: "$", t: "ran: go test ./internal/auth" },
    { dt: 9, s: "c", g: "■", t: "ran Edit on router_test.go", n: 2 },
    { dt: 11, s: "x", g: "≡", t: "turn complete: login bug fixed, tests pass", set: "idle" },
    { dt: 2, s: "c", g: "●", t: "ran tool Grep" },
    { dt: 14, s: "c", g: "$", t: "ran shell tool: git commit" },
    { dt: 12, s: "o", g: "?", t: "permission answered: once", set: "working" },
    { dt: 2, s: "o", g: "$", t: "ran shell tool" },
    { dt: 8, s: "o", g: "■", t: "edited index.html", n: 12 },
    { dt: 6, s: "o", g: "≡", t: "assistant message" },
    { dt: 9, s: "c", g: "?", t: "notification: permission_prompt", tone: "needs", set: "needs", reason: "notification: permission_prompt" },
    { dt: 5, s: "o", g: "●", t: "tool: read" },
    { dt: 21, s: "x", g: "▸", t: 'prompt: "add a rate limit to /login"', set: "working" },
    { dt: 16, s: "c", g: "$", t: "ran shell tool: git push", set: "working" },
    { dt: 2, s: "c", g: "◆", t: "agent finished responding", set: "idle" },
    { dt: 4, s: "x", g: "$", t: "ran: rg limiter internal/auth" },
    { dt: 7, s: "o", g: "?", t: "permission requested", tone: "needs", set: "needs", reason: "approve Run: rm -rf build" },
    { dt: 13, s: "x", g: "■", t: "patched limiter.go" },
    { dt: 18, s: "x", g: "$", t: "ran: go test ./..." },
    { dt: 24, s: "c", g: "▸", t: "user prompt submitted", set: "working" },
    { dt: 3, s: "c", g: "●", t: "ran tool Read" },
    { dt: 16, s: "x", g: "!", t: "patch failed", tone: "err" },
    { dt: 22, s: "x", g: "■", t: "patched limiter.go, limiter_test.go" },
    { dt: 19, s: "x", g: "$", t: "ran: go test ./..." },
    { dt: 27, s: "x", g: "≡", t: "turn complete: rate limit added, tests pass", set: "idle" },
    { dt: 2, s: "c", g: "■", t: "ran Edit on health.go" },
    { dt: 41, s: "c", g: "$", t: "ran shell tool" },
    { dt: 6, s: "c", g: "●", t: "ran tool Grep" },
    { dt: 12, s: "c", g: "■", t: "ran Edit on health_test.go" },
    { dt: 17, s: "c", g: "$", t: "ran shell tool" },
    { dt: 21, s: "c", g: "◆", t: "agent finished responding", set: "idle" },
    { dt: 14, s: "c", g: "▸", t: "user prompt submitted", set: "working" },
    { dt: 20, s: "c", g: "●", t: "ran tool Read" },
  ];
  let now = 0; // simulated seconds since local midnight
  let cursor = 0;
  let total = 0;
  const rows = [];

  function apply(item) {
    now += item.dt;
    const s = sessions[item.s];
    s.times.push(now);
    if (s.times.length > 64) s.times.shift();
    s.did = item.t;
    if (item.set && item.set !== s.state) {
      s.state = item.set;
      s.since = now;
    }
    if (item.set === "needs") s.reason = item.reason;
    total += item.n || 1;
    rows.push({ at: now, item });
    if (rows.length > FEED_ROWS) rows.shift();
  }

  // Run the loop once unseen so the first frame is a session already in
  // progress, then pin the clock so the next event lands at 10:04:12.
  for (const item of SCRIPT) apply(item);
  const shift = 10 * 3600 + 4 * 60 + 12 - SCRIPT[0].dt - now;
  now += shift;
  for (const s of Object.values(sessions)) {
    s.since += shift;
    s.times = s.times.map((t) => t + shift);
  }
  for (const r of rows) r.at += shift;
  total = 1204;

  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function age(sec) {
    if (sec < 60) return `${Math.max(0, Math.floor(sec))}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h`;
  }

  function buckets(s) {
    const out = new Array(BUCKETS).fill(0);
    for (const t of s.times) {
      const i = BUCKETS - 1 - Math.floor((now - t) / BUCKET_S);
      if (i >= 0 && i < BUCKETS) out[i] += 1;
    }
    return out;
  }

  function renderHead(paused) {
    const waiting = Object.values(sessions)
      .filter((s) => s.state === "needs")
      .sort((a, b) => a.since - b.since);
    const mode = paused ? '<span class="paused">⏸ PAUSED</span>' : '<span class="live">● LIVE</span>';
    let html = `<b>AGENT FIREHOSE</b> ${mode} <span class="dim">${total.toLocaleString("en-US")} events</span>`;
    if (waiting.length) {
      html += ` <span class="needs">NEEDS YOU · ${waiting.length} · ${esc(waiting[0].reason)}</span>`;
    }
    headEl.innerHTML = html;
  }

  function renderBand() {
    const all = Object.values(sessions);
    const counts = all.map(buckets);
    const scale = Math.max(1, ...counts.flat());
    // Sessions that need you come first, longest wait first.
    const order = all
      .map((s, i) => ({ s, i }))
      .sort((a, b) => {
        const an = a.s.state === "needs";
        const bn = b.s.state === "needs";
        if (an !== bn) return an ? -1 : 1;
        return an ? a.s.since - b.s.since : a.i - b.i;
      });
    bandEl.innerHTML = order
      .map(({ s, i }) => {
        const dwell = now - s.since;
        const p = Math.min(dwell, DWELL_MAX) / DWELL_MAX;
        const spark = counts[i]
          .map((n) => `<i style="--h:${n ? Math.min(8, Math.max(1, Math.ceil((n * 8) / scale))) : 0}"></i>`)
          .join("");
        const needs = s.state === "needs";
        return (
          `<li><span class="sbar ${s.cls}">│</span><span class="agent">${s.agent}</span>` +
          `<span class="spark">${spark}</span><span class="dwell" style="--p:${p.toFixed(3)}"></span>` +
          `<span class="age">${age(dwell)}</span>` +
          `<span class="state${needs ? " needs" : ""}">${needs ? "NEEDS YOU" : s.state}</span>` +
          `<span class="did">${esc(needs ? s.reason : s.did)}</span></li>`
        );
      })
      .join("");
  }

  function renderFeed(flash) {
    let prev = null;
    feedEl.innerHTML = rows
      .map((r, i) => {
        const h = Math.floor(r.at / 3600) % 24;
        const m = Math.floor(r.at / 60) % 60;
        const sec = Math.floor(r.at % 60);
        // The clock and the workspace print only when they change.
        const sameMinute = prev && Math.floor(prev.at / 60) === Math.floor(r.at / 60);
        const clock = sameMinute ? `:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
        const s = sessions[r.item.s];
        const ws = prev && sessions[prev.item.s].ws === s.ws ? "" : s.ws;
        prev = r;
        const tone = r.item.tone ? ` ${r.item.tone}` : "";
        const count = r.item.n ? ` <span class="dim">×${r.item.n}</span>` : "";
        const fresh = flash && i === rows.length - 1 ? ' class="is-new"' : "";
        return (
          `<li${fresh}><span class="clk">${clock}</span><span class="sbar ${s.cls}">│</span>` +
          `<span class="agent">${s.agent}</span>` +
          `<span class="ev"><i class="g${tone}">${r.item.g}</i>${esc(r.item.t)}${count}</span>` +
          `<span class="ws">${ws}</span></li>`
        );
      })
      .join("");
  }

  function render(flash) {
    renderHead(!wanted);
    renderBand();
    renderFeed(flash);
  }

  let playing = false;
  let wanted = !reduceMotion.matches; // what the reader asked for
  let onScreen = true;
  let timer = 0;

  function tick() {
    const item = SCRIPT[cursor];
    cursor = (cursor + 1) % SCRIPT.length;
    apply(item);
    render(true);
    queue();
  }

  function queue() {
    clearTimeout(timer);
    if (!playing) return;
    const next = SCRIPT[cursor];
    timer = setTimeout(tick, 650 + Math.min(next.dt, 22) * 48);
  }

  function sync() {
    const should = wanted && onScreen && !document.hidden;
    if (should !== playing) {
      playing = should;
      queue();
    }
    toggle.textContent = wanted ? "Pause" : "Play";
    toggle.setAttribute("aria-label", wanted ? "Pause the demo" : "Play the demo");
    renderHead(!wanted);
  }

  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    wanted = !wanted;
    sync();
  });
  document.addEventListener("visibilitychange", sync);
  new IntersectionObserver(
    (entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      sync();
    },
    { threshold: 0.15 },
  ).observe(demo);

  render(false);
  sync();
})();
