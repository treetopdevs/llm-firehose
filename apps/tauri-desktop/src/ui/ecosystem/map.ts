import type {FirehoseEvent} from "../../api";
import type {PatchBed} from "./model";
import {patchPhase} from "./model";
/** Stable file beds: growth counts source observations, never changed lines or quality. */
export function renderEcosystemMap(beds:PatchBed[],events:FirehoseEvent[],onBed:(bed:PatchBed)=>void,page?:{offset:number;filtered:number;total:number}):HTMLElement {
 const root=document.createElement('section');root.className='ecosystem-map';
 const legend=document.createElement('p');legend.textContent=`${page ? `${beds.length ? page.offset+1 : 0}–${page.offset+Math.min(20,beds.length)} of ${page.filtered} filtered / ${page.total} total file beds` : `${Math.min(20,beds.length)} of ${beds.length} file beds`}. File observations may include reads. Stem height: 6 pixels per observation, capped at 20. Up to 20 leaves per bed. Blue: attempt; green: reported completion; red: failure; gray: unknown. Amber stem: repeated observations, not conflict or quality. Reversions and net content changes unavailable.`;root.append(legend);
 const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px';
 const byID=new Map(events.map(e=>[e.id,e]));
 const colors={attempt:'#81b9ec',complete:'#8ab897',failed:'#e27d77',unknown:'#a0a6b3'};
 for(const bed of beds.slice(0,20)){
  const visible=bed.eventIds.map(id=>byID.get(id)).filter((e):e is FirehoseEvent=>!!e);
  const counts={attempt:0,complete:0,failed:0,unknown:0};for(const e of visible)counts[patchPhase(e)]++;
  const button=document.createElement('button');button.type='button';button.style.cssText='min-width:0;text-align:left;padding:12px;border:1px solid #34404e;border-radius:12px;background:#151d21;color:inherit';
  button.setAttribute('aria-label',`${bed.path} / ${bed.workspace}: ${visible.length} observations; ${counts.attempt} attempts, ${counts.complete} reported completions, ${counts.failed} failures, ${counts.unknown} unknown; recorded tools: ${[...new Set(visible.map(e=>e.name || "not recorded"))].join(", ")}`);
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 180 150');svg.setAttribute('aria-hidden','true');svg.style.cssText='width:100%;height:150px';
  const ground=document.createElementNS(ns,'path');ground.setAttribute('d','M 10 140 Q 90 120 170 140');ground.setAttribute('stroke','#485e4f');ground.setAttribute('fill','none');svg.append(ground);
  if(visible.length){const stem=document.createElementNS(ns,'line');stem.setAttribute('x1','90');stem.setAttribute('y1','135');stem.setAttribute('x2','90');stem.setAttribute('y2',String(135-6*Math.min(20,visible.length)));stem.setAttribute('stroke',visible.length>1?'#d7ab63':'#a0a6b3');stem.setAttribute('stroke-width','3');svg.append(stem);}
  visible.slice(0,20).forEach((event,i)=>{const leaf=document.createElementNS(ns,'ellipse');leaf.setAttribute('cx',String(90+(i%2?12:-12)));leaf.setAttribute('cy',String(132-i*6));leaf.setAttribute('rx','12');leaf.setAttribute('ry','4');leaf.setAttribute('fill',colors[patchPhase(event)]);leaf.setAttribute('data-leaf',event.id);svg.append(leaf);});
  const label=document.createElement('div');label.textContent=bed.path;label.style.cssText='overflow-wrap:anywhere;font-weight:600';
  const detail=document.createElement('p');detail.textContent=`${visible.length} observations · ${counts.attempt} attempts · ${counts.complete} reported completions · ${counts.failed} failures · ${counts.unknown} unknown. ${Math.min(20,visible.length)} leaves shown.`;
  const workspace=document.createElement('small');workspace.textContent=bed.workspace;workspace.style.overflowWrap='anywhere';
  button.append(svg,label,detail,workspace);button.addEventListener('click',()=>onBed(bed));grid.append(button);
 }
 root.append(grid);return root;
}
