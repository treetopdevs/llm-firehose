// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,test,vi} from "vitest";
import fixture from "./fixture.session.json";
import type {FirehoseEvent} from "../../api";
const api=vi.hoisted(()=>({sessionEvents:vi.fn(),errorSignatures:vi.fn(),capturedEvent:vi.fn()}));
vi.mock("../../api",()=>api);
import {createScore} from "./index";
const real=(fixture as FirehoseEvent[])[0];
// Normalized time/category mutations of a real captured envelope.
const rows=[0,1000,2000,10000].map((ms,i)=>({...real,id:`sound-${i}`,time:new Date(1800000000000+ms).toISOString(),category:i===1?"file":"message",severity:i===2?"error":"info"}));
const button=(root:HTMLElement,label:string)=>root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
function audioHost(){
 const voices:{frequency:{value:number};stop:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}[]=[];
 const context={state:"running",currentTime:0,destination:{},resume:vi.fn().mockResolvedValue(undefined),close:vi.fn().mockResolvedValue(undefined),createGain:()=>({gain:{setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn()}),createOscillator:vi.fn(()=>{const voice={frequency:{value:0},type:"",connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),onended:null};voices.push(voice);return voice;})};
 const ctor=vi.fn(function(){return context;});vi.stubGlobal("AudioContext",ctor);return {context,voices,ctor};
}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal("requestAnimationFrame",vi.fn());api.sessionEvents.mockResolvedValue(rows);api.errorSignatures.mockResolvedValue([]);api.capturedEvent.mockResolvedValue(real);});
afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals();});
test("explicit sound control, crossed observations, gaps and silent transport changes",async()=>{
 const h=audioHost(),panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 expect(h.ctor).not.toHaveBeenCalled();button(panel.root,"Enable replay sound").click();expect(h.ctor).toHaveBeenCalledOnce();await Promise.resolve();
 expect(button(panel.root,"Disable replay sound").getAttribute("aria-pressed")).toBe("true");
 button(panel.root,"play").click();panel.tick(10);expect(h.voices).toHaveLength(0);panel.tick(1090);expect(h.voices[0].frequency.value).toBe(440);
 h.context.currentTime=.2;panel.tick(1000);expect(h.voices[1].frequency.value).toBe(220);
 h.context.currentTime=.4;panel.tick(1000);expect(h.voices).toHaveLength(2);
 button(panel.root,"play").click();expect(h.voices[1].disconnect).toHaveBeenCalled();panel.tick(1000);expect(h.voices).toHaveLength(2);
 button(panel.root,"jump to next event").click();expect(h.voices).toHaveLength(2);
 button(panel.root,"play").click();panel.tick(20000);expect(h.voices).toHaveLength(2);
 await panel.open(real.session_id!,real.source);expect(h.context.close).toHaveBeenCalledOnce();expect(button(panel.root,"Enable replay sound")).not.toBeNull();panel.deactivate();
});
test("blocked audio and a cue failure remain visible while replay continues",async()=>{
 const h=audioHost(),panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 h.context.resume.mockRejectedValueOnce(Error("blocked"));button(panel.root,"Enable replay sound").click();await Promise.resolve();await Promise.resolve();
 expect(panel.root.textContent).toContain("Replay sound unavailable");button(panel.root,"Enable replay sound").click();await Promise.resolve();
 h.context.createOscillator.mockImplementationOnce(()=>{throw Error("device failed")});button(panel.root,"play").click();panel.tick(1100);
 expect(panel.root.textContent).toContain("Replay sound unavailable");const before=panel.playhead();panel.tick(1000);expect(panel.playhead()).toBeGreaterThan(before);panel.deactivate();
});
test("a tick observing a detached paused panel disables audio",async()=>{
 const h=audioHost(),panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 button(panel.root,"Enable replay sound").click();await Promise.resolve();panel.root.remove();panel.tick(0);expect(h.context.close).toHaveBeenCalledOnce();panel.deactivate();
});

test("stepping during playback stops the active voice without playing a seek cue",async()=>{
 const h=audioHost(),panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 button(panel.root,"Enable replay sound").click();await Promise.resolve();button(panel.root,"play").click();panel.tick(1100);
 expect(h.voices).toHaveLength(1);expect(h.voices[0].disconnect).not.toHaveBeenCalled();
 button(panel.root,"jump to next event").click();expect(h.voices[0].disconnect).toHaveBeenCalled();expect(h.voices).toHaveLength(1);panel.deactivate();
});

test("the sound disclosure keyboard action does not toggle playback",async()=>{
 const panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 const summary=panel.root.querySelector("summary")!;summary.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}));
 expect(button(panel.root,"play").getAttribute("aria-pressed")).toBe("false");panel.deactivate();
});

test("a dense window cues only its latest observation, not an earlier error",async()=>{
 api.sessionEvents.mockResolvedValue([...rows,{...rows[2],id:"later-message",time:new Date(1800000002500).toISOString(),category:"message",severity:"info"}]);
 const h=audioHost(),panel=createScore(vi.fn());document.body.append(panel.root);await panel.open(real.session_id!,real.source);
 button(panel.root,"Enable replay sound").click();await Promise.resolve();button(panel.root,"play").click();panel.tick(2600);
 expect(h.voices).toHaveLength(1);expect(h.voices[0].frequency.value).toBe(587);panel.deactivate();
});
