import {expect, test} from "vitest";
import type {FirehoseEvent} from "../../api";
import native from "./fixture.opencode.json";
import {buildLoom, loomTraversal} from "./model";
// Normalized graph-contract mutations of captured OpenCode message receipts.
const message = native[1] as FirehoseEvent;
const row = (id: string, parent?: string): FirehoseEvent => ({...message, id, message_id: id, parent_id: parent});
const model = (rows: FirehoseEvent[]) => buildLoom(rows, "opencode", "ses_fixture01");
const ids = (result: ReturnType<typeof loomTraversal>) => result.groups.map(g => g.id);

test("follows the selected direction and reference depth without crossing sibling branches", () => {
 const m = model([row("a"), row("b","a"), row("c","b"), row("d","c"), row("sibling","b")]);
 expect(ids(loomTraversal(m,"c","upstream",1))).toEqual(["b","c"]);
 expect(ids(loomTraversal(m,"c","upstream",2))).toEqual(["a","b","c"]);
 expect(ids(loomTraversal(m,"b","downstream",2))).toEqual(["b","c","d","sibling"]);
 expect(ids(loomTraversal(m,"c","both",2))).toEqual(["a","b","c","d","sibling"]);
});

test("cycles terminate; depth is capped and results stay deterministic", () => {
 const rows = [row("a","f"),row("b","a"),row("c","b"),row("d","c"),row("e","d"),row("f","e")];
 const m = model(rows);
 expect(ids(loomTraversal(m,"a","downstream",99))).toEqual(["a","b","c","d","e"]);
 expect(loomTraversal(m,"a","both",4).parents).toHaveLength(6);
 expect(loomTraversal(model([...rows].reverse()),"a","both",4)).toEqual(loomTraversal(m,"a","both",4));
 expect(ids(loomTraversal(m,"a","downstream",NaN))).toEqual(["a","b"]);
 expect(loomTraversal(m,"absent","both",4)).toEqual({groups:[],parents:[]});
});

test("conflicting references are terminal and foreign scopes cannot resolve missing parents", () => {
 const rows = [row("a","b"),{...row("a","x"),id:"second-a"},row("b","c"),row("c"), {...row("x"),session_id:"foreign"}];
 const m = model(rows);
 const before = JSON.stringify(m);
 const result = loomTraversal(m,"a","upstream",4);
 expect(ids(result)).toEqual(["a","b","x"]);
 expect(result.parents.map(p=>p.status)).toEqual(["conflicting","conflicting"]);
 expect(JSON.stringify(m)).toBe(before);
 const missing = loomTraversal(model([row("a","x"),{...row("x"),source:"foreign"}]),"a","upstream",4);
 expect(missing.parents[0].status).toBe("missing");
 expect(ids(missing)).toEqual(["a","x"]);
});

test("depth normalization and non-message groups preserve one-hop semantics", () => {
 const m = model([row("a"),row("b","a"),row("c","b")]);
 for(const depth of [0,-9,Infinity,-Infinity,NaN,1.9]) expect(ids(loomTraversal(m,"c","upstream",depth))).toEqual(["b","c"]);
 expect(ids(loomTraversal(m,"c","upstream",2.5))).toEqual(["a","b","c"]);
 const call = {...row("call"),message_id:undefined,call_id:"only-call"};
 expect(ids(loomTraversal(model([call]),"call","both",4))).toEqual(["only-call"]);
});

test("10k fan-out remains complete and terminal conflicts do not expand downstream", () => {
 const rows = [row("root"),...Array.from({length:10_000},(_,i)=>row(`child-${i}`,"root"))];
 const result=loomTraversal(model(rows),"root","downstream",4);
 expect(result.groups).toHaveLength(10_001); expect(result.parents).toHaveLength(10_000);
 const conflict=model([row("a"),row("b","a"),{...row("b","x"),id:"b-again"},row("c","b")]);
 expect(ids(loomTraversal(conflict,"a","downstream",4))).toEqual(["a","b"]);
});
