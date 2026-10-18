// @vitest-environment happy-dom
import {expect,test} from "vitest";
import {errorRange,renderErrorPaths} from "./errors";
import type {ActivityErrorPath} from "../graph/api";
// Additive normalized API contract fixture: no invented raw adapter payload.
const paths:ActivityErrorPath[]=[{path:"src/a.ts",group:"",total:3,omitted_signatures:0,signatures:[{key:"source|file|Edit|failed",total:2,counts:[[0,1],[2,1]]},{key:"other",total:1,counts:[[1,1]]}]}];
test("recurrence uses a single canonical signature in brushed buckets",()=>{
 expect(errorRange(paths,0,1)[0]).toMatchObject({count:1,repeated:0});
 expect(errorRange(paths,0,2)[0]).toMatchObject({count:2,repeated:0});
 expect(errorRange(paths,0,3)[0]).toMatchObject({count:3,repeated:1});
 expect(errorRange(paths,3,4)).toEqual([]);
});
test("error list pages paths, retains exact group identity and discloses omitted signatures",()=>{
 const many=Array.from({length:21},(_,i)=>({...paths[0],group:`workspace-${i}`,omitted_signatures:2}));
 const root=renderErrorPaths(errorRange(many,0,3));
 expect(root.querySelectorAll('li').length).toBe(20);expect(root.textContent).toContain('2 signatures omitted');
 [...root.querySelectorAll('button')].find(b=>b.textContent==='Next error paths')!.click();
 expect(root.querySelectorAll('li').length).toBe(1);expect(root.textContent).toContain('workspace-20');
});

test("paging retains keyboard focus and announces range",()=>{
 const state={page:0};const many=errorRange(Array.from({length:41},(_,i)=>({...paths[0],path:`p${i}`})),0,3);
 const root=renderErrorPaths(many,new Map(),state);document.body.append(root);
 const next=[...root.querySelectorAll('button')].find(b=>b.textContent==='Next error paths')!;next.focus();next.click();
 expect(document.activeElement?.textContent).toBe('Next error paths');expect(root.querySelector('[role="status"]')?.textContent).toContain('21–40');
 const refreshed=renderErrorPaths(many,new Map(),state);expect(refreshed.textContent).toContain('21–40');root.remove();
});
test("omission-only rows explicitly disclose unknown range and format group labels",()=>{
 const root=renderErrorPaths(errorRange([{...paths[0],group:'unknown',omitted_signatures:2}],3,4));
 expect(root.textContent).toContain('No retained observations in range');expect(root.textContent).toContain('Outside known worktrees');
});

test("last page focuses heading and retains API row order",()=>{
 const many=errorRange(Array.from({length:21},(_,i)=>({...paths[0],path:`p${20-i}`})),0,3);const root=renderErrorPaths(many);document.body.append(root);
 expect([...root.querySelectorAll('li strong')].map(n=>n.textContent)).toEqual(many.slice(0,20).map(p=>p.path));
 root.querySelectorAll<HTMLButtonElement>('button')[1].click();expect(document.activeElement?.tagName).toBe('H3');root.remove();
});
