// @vitest-environment happy-dom
import {expect,test,vi} from "vitest";
import type {FirehoseEvent} from "../../api";
import {renderReplayMap} from "./map";
const events=Array.from({length:50},(_,i)=>({id:String(i),time:'2026-10-18T00:00:00Z',source:'codex',session_id:'s',category:'tool',summary:`observation ${i}`}));
test('captured lane centers bounded window on exact anchor; hypothetical lane never implies execution',()=>{
 const select=vi.fn(),root=renderReplayMap(events,'30',['inspect error','run narrower test'],select);
 expect(root.querySelectorAll('button')).toHaveLength(20);
 expect(root.querySelector('[aria-current="true"]')?.textContent).toContain('30');
 expect(root.textContent).toContain('20 of 50');expect(root.textContent).toContain('Hypothetical');expect(root.textContent).toContain('unknown');
 root.querySelector<HTMLButtonElement>('[aria-current="true"]')!.click();expect(select).toHaveBeenCalledWith(events[30]);
});
test('missing anchors remain explicit, user text safe and alternative count bounded',()=>{
 const root=renderReplayMap(events,'missing',Array.from({length:15},()=>'<script>unsafe</script>'),()=>{});
 expect(root.textContent).toContain('Saved anchor not in loaded snapshot');expect(root.querySelectorAll('[data-alternative]')).toHaveLength(12);expect(root.querySelector('script')).toBeNull();expect(root.textContent).toContain('12 of 15');
});
test("the observation label names the session but keeps the event id", () => {
    const e = { id: "ev-1", source: "codex", session_id: "2385e3bc-1111", time: "2026-07-02T10:00:00Z", category: "tool" } as never;
    const named = renderReplayMap([e], undefined, [], vi.fn(), "Fix login bug");
    expect(named.querySelector("button")!.getAttribute("aria-label")).toBe("Captured observation codex / Fix login bug / ev-1");
    const bare = renderReplayMap([e], undefined, [], vi.fn());
    expect(bare.querySelector("button")!.getAttribute("aria-label")).toBe("Captured observation codex / 2385e3bc-1111 / ev-1");
});
test('replay styles reference only tokens declared on :root, no hex',async()=>{
 const {readFileSync}=await import("node:fs");const {parseTokens}=await import("../../tokens-helpers");
 const declared=Object.keys(parseTokens(readFileSync("src/styles.css","utf8")).base);
 const root=renderReplayMap(events,'30',['a'],()=>{});
 const used=[...root.innerHTML.matchAll(/var\(\s*(--[\w-]+)/g)].map(m=>m[1]);
 expect(used).toEqual(expect.arrayContaining(['--observed','--replay-alt','--replay-alt-bg']));
 expect(used.filter(n=>!declared.includes(n))).toEqual([]);
 expect(root.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
});
