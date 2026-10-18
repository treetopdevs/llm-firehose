// @vitest-environment happy-dom
import {expect,test,vi} from "vitest";
import type {FirehoseEvent} from "../../api";
import type {PatchBed} from "./model";
import {renderEcosystemMap} from "./map";
test("bounded beds remain selectable with exact counts and safe labels",()=>{
 const events=Array.from({length:25},(_,i)=>({id:String(i),payload:{status:"success"}} as FirehoseEvent));
 const beds=Array.from({length:22},(_,i)=>({key:String(i),path:i?'file'+i:'<img src=x onerror=x>',workspace:'workspace',eventIds:events.map(e=>e.id)}));
 const select=vi.fn(),root=renderEcosystemMap(beds,events,select);
 expect(root.querySelectorAll('button')).toHaveLength(20);
 expect(root.querySelectorAll('[data-leaf]')).toHaveLength(400);
 expect(root.textContent).toContain('20 of 22 file beds');
 expect(root.textContent).toContain('25 observations');
 expect(root.querySelector('img')).toBeNull();root.querySelector('button')!.click();expect(select).toHaveBeenCalledWith(beds[0]);
});
test("empty replay beds keep their position and disclose no visible activity",()=>{
 const bed:PatchBed={key:'x',path:'file',workspace:'unknown',eventIds:['later']};
 const root=renderEcosystemMap([bed],[],()=>{});
 expect(root.querySelectorAll('button')).toHaveLength(1);expect(root.querySelectorAll('[data-leaf]')).toHaveLength(0);
 expect(root.textContent).toContain('0 observations');
});
