import {expect,test} from "vitest";
import type {FirehoseEvent} from "../../api";
import fixture from "../score/fixture.session.json";
import {sequenceRuns,compareSequences} from "./sequence";
const real=fixture as FirehoseEvent[];
test("runs retain exact recorded fields, counts and interval boundaries",()=>{
 // Normalized contract mutations of a real captured envelope, not adapter fixtures.
 const e=real[0];const events=[{...e,id:'baseline'},...['one','two','closing'].map(id=>({...e,id,name:'PostToolUse',category:'tool',severity:'info',payload:{tool_name:'Read'}}))];
 const runs=sequenceRuns(events,0,3);
 expect(runs).toHaveLength(1);expect(runs[0].events.map(e=>e.id)).toEqual(['one','two','closing']);expect(runs[0].closing).toBe(true);expect(runs[0].tool).toBe('Read');
});
test("recorded tool, severity and collision-free identity remain distinct",()=>{
 const e=real[0];const events=[e,{...e,source:'a|b',category:'c',name:'d',payload:{}},{...e,source:'a',category:'b|c',name:'d',payload:{}},{...e,payload:{}},{...e,payload:{tool_name:['missing']}},{...e,payload:{tool_name:'Read'}},{...e,payload:{tool_name:'Write'}},{...e,severity:'error',payload:{tool_name:'Write'}}];
 const runs=sequenceRuns(events,0,7);expect(runs).toHaveLength(7);expect(new Set(runs.map(r=>r.key)).size).toBe(7);expect(runs[6].closing).toBe(true);
});
test("alignment matches full runs and prefers A removal on ambiguous ties",()=>{
 const e=real[0];const runs=(names:string[])=>sequenceRuns([e,...names.map(name=>({...e,name}))],0,names.length);
 expect(compareSequences(runs(['A','B']),runs(['B','A'])).rows?.map(r=>[r.kind,r.a?.name,r.b?.name])).toEqual([['only-A','A',undefined],['match','B','B'],['only-B',undefined,'A']]);
 expect(compareSequences(runs(['A','A']),runs(['A'])).equal).toBe(false);
 expect(compareSequences([],[])).toMatchObject({equal:true,rows:[]});
});
test("complete equality and caps hold for200,201 and100000 alternating observations",()=>{
 const e=real[0];const events=[e,...Array.from({length:100000},(_,i)=>({...e,id:String(i),name:i%2?'A':'B'}))];
 const all=sequenceRuns(events,0,100000);expect(all).toHaveLength(100000);
 expect(compareSequences(all.slice(0,200),all.slice(0,200)).rows).toHaveLength(200);
 expect(compareSequences(all.slice(0,201),all.slice(0,201))).toMatchObject({equal:true,rows:undefined});
 const changed=[...all];changed[99999]={...changed[99999],key:'different'};
 expect(compareSequences(all,changed)).toMatchObject({equal:false,rows:undefined});expect(events[1].id).toBe('0');
});
test("opaque tool metadata is stable across object key order and remains unreadable",()=>{
 const e=real[0];const runs=sequenceRuns([e,{...e,payload:{tool_name:{sha256:'hash',len:4}}},{...e,payload:{tool_name:{len:4,sha256:'hash'}}}],0,2);
 expect(runs).toHaveLength(1);expect(runs[0].tool).toBe('Unavailable');expect(runs[0].events).toHaveLength(2);
});
