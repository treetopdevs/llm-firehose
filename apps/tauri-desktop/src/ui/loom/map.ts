import type {FirehoseEvent} from "../../api";
import type {LoomGroup,LoomParent} from "./model";
let serial=0;
/** A bounded neighborhood, not a time axis or inferred causal graph. */
export function renderLoomMap(focus:FirehoseEvent,groups:LoomGroup[],parents:LoomParent[],onGroup:(g:LoomGroup)=>void):HTMLElement {
 const root=document.createElement("section"); root.className="loom-map";
 const shown=groups.slice(0,20), height=Math.max(180,shown.length*58+70);
 const positions=new Map(shown.map((g,i)=>[g.key,{x:380,y:65+i*58}]));
 const refs=parents.filter(p=>positions.has(p.parentKey)&&positions.has(p.childKey)).slice(0,20);
 const note=document.createElement("p"); note.textContent=`${shown.length} of ${groups.length} groups · ${refs.length} of ${parents.length} parent references shown. Dashed lines: shared identifier membership. Arrows: native parent message reference, not proven cause. All groups and references are available in the lists below.`; root.append(note);
 const viewport=document.createElement("div"); viewport.style.cssText="max-height:480px;overflow:auto";
 const canvas=document.createElement("div"); canvas.style.cssText=`position:relative;min-width:640px;height:${height}px`;
 const ns="http://www.w3.org/2000/svg";
 const svg=document.createElementNS(ns,"svg"); svg.setAttribute("width","640"); svg.setAttribute("height",String(height)); svg.setAttribute("aria-hidden","true"); svg.style.cssText="position:absolute;inset:0;pointer-events:none";
 const defs=document.createElementNS(ns,"defs"),marker=document.createElementNS(ns,"marker"),arrow=document.createElementNS(ns,"path"),markerId=`loom-arrow-${++serial}`;
 marker.setAttribute("id",markerId);marker.setAttribute("viewBox","0 0 10 10");marker.setAttribute("refX","9");marker.setAttribute("refY","5");marker.setAttribute("markerWidth","7");marker.setAttribute("markerHeight","7");marker.setAttribute("orient","auto-start-reverse");arrow.setAttribute("d","M 0 0 L 10 5 L 0 10 z");arrow.setAttribute("fill","currentColor");marker.append(arrow);defs.append(marker);svg.append(defs);
 for(const g of shown){const p=positions.get(g.key)!;
  if(g.members.includes(focus.id)){const line=document.createElementNS(ns,"line");line.setAttribute("x1","210");line.setAttribute("y1","40");line.setAttribute("x2",String(p.x));line.setAttribute("y2",String(p.y));line.setAttribute("stroke","currentColor");line.setAttribute("stroke-dasharray","4 5");line.setAttribute("data-membership",g.key);svg.append(line);}
  const button=document.createElement("button");button.type="button";button.textContent=`${g.kind}: ${g.id} (${g.members.length})`;button.title=`${g.kind}: ${g.id} · ${g.members.length} captured members`;button.style.cssText=`position:absolute;left:${p.x}px;top:${p.y-20}px;width:220px;height:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;button.addEventListener("click",()=>onGroup(g));canvas.append(button);
 }
 for(const [i,r] of refs.entries()){const a=positions.get(r.parentKey)!,b=positions.get(r.childKey)!,lane=620+(i%3)*6;const path=document.createElementNS(ns,"path");path.setAttribute("d",`M 602 ${a.y-8} C ${lane} ${a.y-8}, ${lane} ${b.y+8}, 602 ${b.y+8}`);path.setAttribute("fill","none");path.setAttribute("stroke",r.status==="conflicting"?"var(--warn)":"currentColor");path.setAttribute("marker-end",`url(#${markerId})`);path.setAttribute("data-parent",r.key);svg.append(path);}
 const label=document.createElement("div");label.textContent=`Focus observation: ${focus.summary || focus.id}`;label.style.cssText="position:absolute;left:8px;top:15px;width:200px;overflow-wrap:anywhere";
 canvas.prepend(svg);canvas.append(label);viewport.append(canvas);root.append(viewport);return root;
}
