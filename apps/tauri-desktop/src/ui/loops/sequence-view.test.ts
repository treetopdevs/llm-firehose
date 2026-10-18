// @vitest-environment happy-dom
import {expect,test,vi} from "vitest";
import type {FirehoseEvent} from "../../api";
import fixture from "../score/fixture.session.json";
import {sequenceRuns,compareSequences} from "./sequence";
import {renderSequenceComparison} from "./sequence-view";
const e=(fixture as FirehoseEvent[])[0];
const runs=(names:string[])=>sequenceRuns([e,...names.map((name,i)=>({...e,name,id:String(i)}))],0,names.length);
test("comparison labels recorded matches and explicitly inspects underlying observations",()=>{
 const inspect=vi.fn(),cancel=vi.fn();const root=renderSequenceComparison(compareSequences(runs(['A']),runs(['A'])),inspect,cancel);
 expect(root.querySelector('th[scope="col"]')).toBeTruthy();expect(root.textContent).toContain('match');expect(root.textContent).toContain('closing recurrence');expect(inspect).not.toHaveBeenCalled();
 root.querySelector<HTMLButtonElement>('button')!.click();expect(root.textContent).toContain('Run observations');
 [...root.querySelectorAll('button')].find(b=>b.textContent?.startsWith('Inspect observation'))!.click();expect(inspect).toHaveBeenCalledWith(expect.objectContaining({id:'0'}));expect(cancel).toHaveBeenCalled();
});
test("aligned rows and run observations are fully paged with focus fallback",()=>{
 const many=runs(Array.from({length:41},(_,i)=>String(i)));const root=renderSequenceComparison(compareSequences(many,many),vi.fn(),vi.fn());document.body.append(root);
 expect(root.querySelectorAll('tbody tr')).toHaveLength(40);const next=[...root.querySelectorAll('button')].find(b=>b.textContent==='Next comparison rows')!;next.focus();next.click();
 expect(root.querySelectorAll('tbody tr')).toHaveLength(1);expect(document.activeElement?.tagName).toBe('H3');expect(root.querySelector('[role="status"]')?.textContent).toContain('41–41');root.remove();
 const repeated=runs(Array.from({length:85},()=>'<img>'));const detail=renderSequenceComparison(compareSequences(repeated,repeated),vi.fn(),vi.fn());detail.querySelector<HTMLButtonElement>('button')!.click();
 expect(detail.querySelectorAll('li')).toHaveLength(40);[...detail.querySelectorAll('button')].find(b=>b.textContent==='Next run observations')!.click();expect(detail.querySelectorAll('li')).toHaveLength(40);[...detail.querySelectorAll('button')].find(b=>b.textContent==='Next run observations')!.click();expect(detail.querySelectorAll('li')).toHaveLength(5);expect(detail.querySelector('img')).toBeNull();
});
test("unaligned long sequences keep both sides browsable with unique keys and truncated labels",()=>{
 const a=runs(Array.from({length:201},(_,i)=>i===200?'x'.repeat(200):String(i)));const root=renderSequenceComparison(compareSequences(a,[]),vi.fn(),vi.fn());
 expect(root.textContent).toContain('Alignment unavailable');expect(root.querySelectorAll('li')).toHaveLength(40);
 for(let i=0;i<5;i++)[...root.querySelectorAll('button')].find(b=>b.textContent==='Next A runs')!.click();
 expect(root.textContent).toContain('[label truncated]');expect(root.textContent).toContain('201–201');
 const keys=[...root.querySelectorAll('[data-key]')].map(e=>e.getAttribute('data-key'));expect(new Set(keys).size).toBe(keys.length);
});
test("aligned insertions retain each side's actual run numbering",()=>{
 const root=renderSequenceComparison(compareSequences(runs(['X']),runs(['Y','X'])),vi.fn(),vi.fn());
 expect([...root.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['Browse B run 1','Browse A run 1','Browse B run 2']);
});
