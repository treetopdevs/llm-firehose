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
 expect(root.textContent).toContain('Anchor not in loaded snapshot');expect(root.querySelectorAll('[data-alternative]')).toHaveLength(12);expect(root.querySelector('script')).toBeNull();expect(root.textContent).toContain('12 of 15');
});
