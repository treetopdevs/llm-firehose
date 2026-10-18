import {clear,el} from "../../dom";
import type {ActivityErrorPath} from "../graph/api";
import {stripControl,digestLabel} from "../score/model";

export type ErrorPathRange = {path:string;group:string;count:number;repeated:number;omitted:number;signatures:{key:string;count:number}[]};
export const errorPathKey=(group:string,path:string)=>JSON.stringify([group,path]);

/** Counts are scoped to the brush; omissions describe the full loaded window. */
export function errorRange(paths:ActivityErrorPath[],a:number,b:number):ErrorPathRange[] {
 return paths.map(p=>{
  const signatures=p.signatures.map(s=>({key:s.key,count:s.counts.reduce((n,[i,c])=>n+(i>=a&&i<b?c:0),0)})).filter(s=>s.count>0);
  return {path:p.path,group:p.group,count:signatures.reduce((n,s)=>n+s.count,0),repeated:signatures.filter(s=>s.count>=2).length,omitted:p.omitted_signatures,signatures};
 }).filter(p=>p.count>0||p.omitted>0);
}

export function renderErrorPaths(paths:ErrorPathRange[],names:Map<string,string>=new Map(),state:{page:number}={page:0}):HTMLElement {
 const root=el("section",{class:"map-errors","aria-label":"File-linked errors"});let page=Math.min(state.page,Math.max(0,Math.ceil(paths.length/20)-1));
 function draw(){
  state.page=page;clear(root);
  root.append(el("h3",{tabindex:"-1"},"File-linked errors in range"),el("p",{class:"dim"},"Only paths explicitly carried by captured error observations. An outline marks at least two observations of the same Error Signature in this range, not retries, root cause or file defects. Errors without paths cannot appear here. Heat geometry is unchanged."));
  if(!paths.length){root.append(el("p",{},"No retained file-linked errors in this range."));return;}
  root.append(el("p",{role:"status"},`Showing ${page*20+1}–${Math.min(paths.length,(page+1)*20)} of ${paths.length} error paths; error-only paths may have no Heat tile.`));
  const list=el("ul");
  for(const p of paths.slice(page*20,(page+1)*20)){
   const item=el("li",{},el("strong",{},stripControl(p.path)),el("p",{},`${stripControl(names.get(p.group) || (p.group === "unknown" ? "Outside known worktrees" : digestLabel(p.group) || p.group))||"Repository-relative"} · ${p.count ? `${p.count} retained error observations` : "No retained observations in range; omitted signatures have unknown range"} · ${p.repeated} repeated signatures`));
   if(p.omitted)item.append(el("p",{class:"dim"},`${p.omitted} signatures omitted from the loaded window; range counts and repeats may be incomplete.`));
   const details=el("details",{},el("summary",{},"Signature counts"));
   for(const s of p.signatures)details.append(el("p",{},`${s.count} · ${stripControl(s.key)}`));
   item.append(details);list.append(item);
  }
  root.append(list);
  const previous=el("button",{type:"button"},"Previous error paths"),next=el("button",{type:"button"},"Next error paths");
  previous.disabled=page===0;next.disabled=(page+1)*20>=paths.length;
  function move(delta:number,label:string){page+=delta;draw();const target=[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label&&!b.disabled);(target||root.querySelector<HTMLElement>('h3'))?.focus();}
  previous.onclick=()=>move(-1,"Previous error paths");next.onclick=()=>move(1,"Next error paths");root.append(previous,next);
 }
 draw();return root;
}
