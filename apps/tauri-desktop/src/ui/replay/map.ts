import type {FirehoseEvent} from "../../api";
/** An annotation fork, never execution or a prediction of an alternative outcome. */
export function renderReplayMap(events:FirehoseEvent[],anchorId:string|undefined,steps:string[],onEvent:(event:FirehoseEvent)=>void):HTMLElement {
 const root=document.createElement('section');root.className='replay-map';
 const anchor=events.findIndex(e=>e.id===anchorId),start=anchor<0?0:Math.max(0,Math.min(events.length-20,anchor-10));
 const shown=events.slice(start,start+20);
 const caption=document.createElement('p');caption.textContent=`${shown.length} of ${events.length} captured observations shown (${shown.length?start+1:0}–${start+shown.length}). The full captured route is in the paged list. Recorded order does not prove causality. A fork links an annotation to an observation, not an executed route.`;root.append(caption);
 if(anchorId&&anchor<0){const missing=document.createElement('p');missing.textContent='Anchor not in loaded snapshot. No nearby observation is substituted.';root.append(missing);}
 const lanes=document.createElement('div');lanes.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px;align-items:start';
 const captured=document.createElement('section'),alternative=document.createElement('section');
 captured.style.cssText='border-left:3px solid #7aa6c8;padding:12px';alternative.style.cssText='border-left:3px dashed #bb9ad3;padding:12px;background:#211d29';
 const h=document.createElement('h3');h.textContent='Captured observations';captured.append(h);
 for(const event of shown){const button=document.createElement('button');button.type='button';button.style.cssText='display:block;width:100%;text-align:left;margin:8px 0;overflow-wrap:anywhere;padding:10px';button.textContent=`${event.id===anchorId?'Fork anchor · ':''}${event.time} · ${event.summary||event.name||event.category} · ${event.id}`;button.setAttribute('aria-label',`Captured observation ${event.source} / ${event.session_id} / ${event.id}`);if(event.id===anchorId){button.setAttribute('aria-current','true');button.style.border='2px solid #bb9ad3';}button.addEventListener('click',()=>onEvent(event));captured.append(button);}
 if(!events.length){const empty=document.createElement('p');empty.textContent='Load a captured route explicitly to inspect its observations.';captured.append(empty);}
 const title=document.createElement('h3');title.textContent='Hypothetical alternative — not executed';const note=document.createElement('p');note.textContent=`${Math.min(12,steps.length)} of ${steps.length} proposed steps. All outcomes and timings are unknown. No commands are run.`;alternative.append(title,note);
 const list=document.createElement('ol');for(const step of steps.slice(0,12)){const row=document.createElement('li');row.setAttribute('data-alternative','');row.textContent=step;row.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0';list.append(row);}alternative.append(list);
 if(!steps.length){const empty=document.createElement('p');empty.textContent='Verify a captured receipt, then sketch an alternative. This lane contains only your annotations.';alternative.append(empty);}
 lanes.append(captured,alternative);root.append(lanes);return root;
}
