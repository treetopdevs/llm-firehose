// @vitest-environment happy-dom
import {beforeEach,expect,test,vi} from 'vitest';
import {createFiles} from './files';
import fixture from './score/fixture.session.json';
const api=vi.hoisted(()=>({files:vi.fn(),fileSessions:vi.fn(),capturedEvent:vi.fn()}));
vi.mock('../api',()=>api);
const captured=fixture.find(e=>e.category==='file')!;
// Derived API rows with normalized scope mutations; not raw adapter fixtures.
const row={workspace_kind:'worktree_id',workspace:'/workspace',path:'src/main.ts',source:captured.source,session_id:captured.session_id,events:1,first_time:captured.time,last_time:captured.time,last_event_id:captured.id};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const click=(root:HTMLElement,text:string)=>{const button=[...root.querySelectorAll('button')].find(b=>b.textContent===text);expect(button).toBeTruthy();button!.click();};
beforeEach(()=>{vi.resetAllMocks();document.body.replaceChildren();api.files.mockResolvedValue([]);api.fileSessions.mockResolvedValue([row,{...row,source:'other-source'},{...row,workspace_kind:'unknown',workspace:'',session_id:''}]);api.capturedEvent.mockResolvedValue(captured);});
test('scoped activity loads explicitly and shows shared recorded scopes without claiming conflicts',async()=>{
 const panel=createFiles();document.body.append(panel.root);panel.refresh();await settle();expect(api.fileSessions).not.toHaveBeenCalled();
 click(panel.root,'Activity by session');await settle();expect(api.fileSessions).toHaveBeenCalledTimes(1);expect(panel.root.textContent).toContain('2 source/session scopes');expect(panel.root.textContent).toContain('Unknown workspace');expect(panel.root.textContent).toContain('does not prove');
});
test('changing modes invalidates a pending scoped receipt',async()=>{
 let done!:(value:unknown)=>void;api.capturedEvent.mockReturnValue(new Promise(r=>done=r));const panel=createFiles();document.body.append(panel.root);panel.refresh();await settle();click(panel.root,'Activity by session');await settle();
 click(panel.root,'Inspect latest observation 1');expect(api.capturedEvent).toHaveBeenCalledWith(captured.id,expect.any(AbortSignal));const signal=api.capturedEvent.mock.calls[0][1] as AbortSignal;
 click(panel.root,'Path summary');done({...captured,summary:'LATE RECEIPT'});await settle();expect(signal.aborted).toBe(true);expect(panel.root.textContent).not.toContain('LATE RECEIPT');
});

test('all scoped rows remain reachable and the final page moves focus to its heading',async()=>{
 api.fileSessions.mockResolvedValue(Array.from({length:85},(_,i)=>({...row,path:`file-${i}`})));
 const panel=createFiles();document.body.append(panel.root);click(panel.root,'Activity by session');await settle();expect(panel.root.querySelectorAll('article')).toHaveLength(40);
 click(panel.root,'Next file activity');expect(panel.root.textContent).toContain('41–80 of 85');click(panel.root,'Next file activity');expect(panel.root.textContent).toContain('81–85 of 85');expect(document.activeElement?.textContent).toBe('Files');
});
test('truncated paths and unknown sessions cannot produce shared badges',async()=>{
 api.fileSessions.mockResolvedValue([{...row,path:'long…'},{...row,path:'long…',source:'other'},{...row,session_id:''},{...row,session_id:'',source:'other'}]);const panel=createFiles();click(panel.root,'Activity by session');await settle();const checkbox=panel.root.querySelector<HTMLInputElement>('[type="checkbox"]')!;checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));expect(panel.root.querySelectorAll('article')).toHaveLength(0);
});
test('receipt with mismatched path or scope is unavailable',async()=>{
 const panel=createFiles();click(panel.root,'Activity by session');await settle();click(panel.root,'Inspect latest observation 1');await settle();expect(panel.root.textContent).toContain('no longer matches');expect(panel.root.querySelector('pre')).toBeNull();
});
test('older daemon failure retains summary and retry controls',async()=>{
 api.fileSessions.mockRejectedValue(new Error('404'));const panel=createFiles();click(panel.root,'Activity by session');await settle();expect(panel.root.textContent).toContain('unavailable on this daemon');click(panel.root,'Path summary');await settle();expect(api.files).toHaveBeenCalled();
});
test('superseded list responses cannot replace the current filter snapshot',async()=>{
 let old!:(value:unknown)=>void;api.fileSessions.mockReturnValueOnce(new Promise(r=>old=r)).mockResolvedValueOnce([{...row,path:'current'}]);
 const panel=createFiles();click(panel.root,'Activity by session');click(panel.root,'Refresh files');await settle();old([{...row,path:'obsolete'}]);await settle();const filter=panel.root.querySelector<HTMLInputElement>('[type="search"]')!;filter.value='current';filter.dispatchEvent(new Event('input'));expect(panel.root.querySelectorAll('article')).toHaveLength(1);
});
test('matching captured receipt renders only after explicit inspection',async()=>{
 const full={...captured,worktree_id:row.workspace,payload:{file_path:row.path}};api.capturedEvent.mockResolvedValue(full);const panel=createFiles();click(panel.root,'Activity by session');await settle();expect(api.capturedEvent).not.toHaveBeenCalled();click(panel.root,'Inspect latest observation 1');await settle();expect(panel.root.querySelector('pre')?.textContent).toContain(captured.id);
});
test('summary paths retain their complete suffix and closing receipt restores its opener',async()=>{
 const path='a'.repeat(170)+'-distinct-suffix';api.files.mockResolvedValue([{path,events:1,sources:['codex'],last_time:captured.time,first_time:captured.time}]);
 const panel=createFiles();document.body.append(panel.root);await panel.refresh();expect(panel.root.textContent).toContain(path);
 api.capturedEvent.mockResolvedValue({...captured,worktree_id:row.workspace,payload:{file_path:row.path}});click(panel.root,'Activity by session');await settle();const opener=[...panel.root.querySelectorAll('button')].find(b=>b.textContent==='Inspect latest observation 1')!;opener.click();await settle();const close=[...panel.root.querySelectorAll('button')].find(b=>b.textContent==='Close file observation')!;close.focus();close.click();expect(document.activeElement).toBe(opener);
});
