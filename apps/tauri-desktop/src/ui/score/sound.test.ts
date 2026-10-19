// @vitest-environment happy-dom
import {afterEach,expect,test,vi} from "vitest";
import {createReplaySound} from "./sound";
function host() {
 const oscillators: any[]=[];
 const context={state:"running",currentTime:0,destination:{},resume:vi.fn().mockResolvedValue(undefined),close:vi.fn().mockResolvedValue(undefined),createGain:vi.fn(()=>({gain:{setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn()})),createOscillator:vi.fn(()=>{const voice={frequency:{value:0},type:"",connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),onended:null};oscillators.push(voice);return voice;})};
 const ctor=vi.fn(function(){return context;}); vi.stubGlobal("AudioContext",ctor);
 return {context,oscillators,ctor};
}
afterEach(()=>vi.unstubAllGlobals());
test("silent by default; explicit enable produces bounded local cues and disable closes audio",async()=>{
 const h=host(), status=vi.fn(),sound=createReplaySound(status);
 sound.cue("error"); expect(h.ctor).not.toHaveBeenCalled();
 await sound.enable(); expect(h.context.resume).toHaveBeenCalledOnce(); expect(h.oscillators).toHaveLength(0);
 sound.cue("error");expect(h.oscillators[0].frequency.value).toBe(220);expect(h.oscillators[0].stop).toHaveBeenCalledWith(.08);
 sound.cue("file");expect(h.oscillators).toHaveLength(1);
 h.context.currentTime=.2;sound.cue("file");expect(h.oscillators[1].frequency.value).toBe(440);
 sound.disable();expect(h.context.close).toHaveBeenCalledOnce();expect(status).toHaveBeenLastCalledWith("off");
 sound.cue("tool");expect(h.oscillators).toHaveLength(2);
});

test("unknown hostile categories use the neutral pitch",async()=>{
 const h=host(),s=createReplaySound(vi.fn());await s.enable();s.cue("constructor");expect(h.oscillators[0].frequency.value).toBe(196);s.disable();
});
test("disable during pending resume prevents late activation and a new enable owns its state",async()=>{
 const h=host(),status=vi.fn(),s=createReplaySound(status);let resolve!:()=>void;
 h.context.resume.mockReturnValueOnce(new Promise<void>(r=>resolve=r));const first=s.enable();expect(h.ctor).toHaveBeenCalledOnce();s.cue("error");expect(h.oscillators).toHaveLength(0);
 s.disable();await s.enable();resolve();await first;expect(status).toHaveBeenLastCalledWith("on");s.disable();
});
test("blocked, suspended and failed contexts disable cues without throwing",async()=>{
 const h=host(),status=vi.fn(),s=createReplaySound(status);
 h.context.state="suspended";await s.enable();expect(status).toHaveBeenLastCalledWith("unavailable");s.cue("error");expect(h.oscillators).toHaveLength(0);
 h.context.state="running";await s.enable();h.context.createOscillator.mockImplementationOnce(()=>{throw Error("blocked")});expect(()=>s.cue("error")).not.toThrow();expect(status).toHaveBeenLastCalledWith("unavailable");
 await s.enable();h.context.state="suspended";(h.context as any).onstatechange();expect(status).toHaveBeenLastCalledWith("unavailable");s.disable();
});
test("pagehide disables audio and rejected resume remains unavailable",async()=>{
 const h=host(),status=vi.fn(),s=createReplaySound(status);await s.enable();window.dispatchEvent(new Event("pagehide"));expect(status).toHaveBeenLastCalledWith("off");
 h.context.resume.mockRejectedValueOnce(Error("denied"));await s.enable();expect(status).toHaveBeenLastCalledWith("unavailable");s.disable();
});

test("hiding a page stops the active tone and never auto-enables on return",async()=>{
 const h=host(),status=vi.fn(),s=createReplaySound(status);await s.enable();s.cue("tool");
 const gain=h.context.createGain.mock.results[0].value;
 expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(.025,.01);
 expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0,.08);
 const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(true);document.dispatchEvent(new Event("visibilitychange"));
 expect(h.oscillators[0].disconnect).toHaveBeenCalled();expect(status).toHaveBeenLastCalledWith("off");
 hidden.mockReturnValue(false);document.dispatchEvent(new Event("visibilitychange"));s.cue("file");expect(h.oscillators).toHaveLength(1);hidden.mockRestore();s.disable();
});

test("unsupported audio is retryable and closing rejection is contained",async()=>{
 vi.stubGlobal("AudioContext",undefined);const status=vi.fn(),s=createReplaySound(status);await s.enable();expect(status).toHaveBeenLastCalledWith("unavailable");
 const h=host();h.context.close.mockRejectedValue(Error("close failed"));await s.enable();expect(status).toHaveBeenLastCalledWith("on");s.disable();await Promise.resolve();expect(status).toHaveBeenLastCalledWith("off");
});
