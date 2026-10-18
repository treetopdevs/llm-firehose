// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import fixture from "./fixture.session.json";
import type {FirehoseEvent} from "../../api";
const api=vi.hoisted(()=>({sessionEvents:vi.fn(),errorSignatures:vi.fn(),capturedEvent:vi.fn()}));
const sound=vi.hoisted(()=>({enable:vi.fn(),disable:vi.fn(),stop:vi.fn(),cue:vi.fn()}));
vi.mock("../../api",()=>api);
vi.mock("./sound",async importOriginal=>({...await importOriginal<typeof import("./sound")>(),createReplaySound:()=>sound}));
import {createScore} from "./index";
const real=(fixture as FirehoseEvent[])[0];
const rows=[0,1000,2000,10000].map((ms,i)=>({...real,id:`sound-${i}`,time:new Date(1800000000000+ms).toISOString(),category:i===1?"file":"message",severity:i===2?"error":"info"}));
const button=(root:HTMLElement,label:string)=>root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal("requestAnimationFrame",vi.fn());api.sessionEvents.mockResolvedValue(rows);api.errorSignatures.mockResolvedValue([]);api.capturedEvent.mockResolvedValue(real);});
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals();});
test("explicit sound control, crossed observations, gaps and silent transport changes",async()=>{
 const panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 expect(sound.enable).not.toHaveBeenCalled();
 expect(button(panel.root,"Enable replay sound")).not.toBeNull();button(panel.root,"Enable replay sound").click();expect(sound.enable).toHaveBeenCalledOnce();
 button(panel.root,"play").click();panel.tick(1100);expect(sound.cue).toHaveBeenLastCalledWith("file");
 panel.tick(1000);expect(sound.cue).toHaveBeenLastCalledWith("error");
 const calls=sound.cue.mock.calls.length;panel.tick(1000);expect(sound.cue).toHaveBeenCalledTimes(calls);
 button(panel.root,"play").click();expect(sound.stop).toHaveBeenCalled();panel.tick(1000);expect(sound.cue).toHaveBeenCalledTimes(calls);
 button(panel.root,"jump to next event").click();expect(sound.cue).toHaveBeenCalledTimes(calls);
 button(panel.root,"play").click();panel.tick(20000);expect(sound.cue).toHaveBeenCalledTimes(calls);
 const disabled=sound.disable.mock.calls.length;await panel.open(real.session_id!,real.source);expect(sound.disable.mock.calls.length).toBe(disabled+1);
 panel.deactivate();expect(sound.disable).toHaveBeenCalled();
});
