// @vitest-environment happy-dom
import {expect,test,vi} from "vitest";
import {renderLoomMap} from "./map";
import type {FirehoseEvent} from "../../api";
import type {LoomGroup} from "./model";
const focus={id:"receipt",summary:"<script>unsafe</script>"} as FirehoseEvent;
const groups:LoomGroup[]=Array.from({length:25},(_,i)=>({key:String(i),kind:"message",id:`msg${i}`,members:i===0?[focus.id]:[]}));
test("bounded diagram has safe accessible group buttons and only native parent arrows",()=>{
 const select=vi.fn(); const root=renderLoomMap(focus,groups,[{key:"p",parentKey:"1",childKey:"0",status:"missing",evidenceIds:[focus.id]}],select);
 expect(root.querySelectorAll("button")).toHaveLength(20);
 expect(root.textContent).toContain("20 of 25 groups");
 expect(root.querySelector("script")).toBeNull();
 expect(root.querySelectorAll('[data-membership]')).toHaveLength(1);
 expect(root.querySelectorAll('[data-parent]')).toHaveLength(1);
 root.querySelector("button")!.click(); expect(select).toHaveBeenCalledWith(groups[0]);
});
test("diagram discloses clipped references and never draws endpoints outside bounded groups",()=>{
 const root=renderLoomMap(focus,groups,[{key:"p",parentKey:"24",childKey:"0",status:"resolved",evidenceIds:[]}],()=>{});
 expect(root.querySelectorAll('[data-parent]')).toHaveLength(0);
 expect(root.textContent).toContain("0 of 1 parent references");
});
