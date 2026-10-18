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
