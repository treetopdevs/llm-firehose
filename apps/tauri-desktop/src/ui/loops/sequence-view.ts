import type {FirehoseEvent} from "../../api";
import {clear,el} from "../../dom";
import {stripControl} from "../score/model";
import type {SequenceComparison,SequenceRun} from "./sequence";
const label=(value:string)=>{const clean=stripControl(value);return clean.length>160?`${clean.slice(0,160)}… [label truncated]`:clean||'(empty)';};
export function renderSequenceComparison(comparison:SequenceComparison,inspect:(event:FirehoseEvent)=>void,cancel:()=>void):HTMLElement{
 const root=el('section',{class:'loops-sequence','aria-label':'Recorded sequence comparison'});
 const heading=el('h3',{tabindex:'-1'},'Recorded sequence comparison'),content=el('div'),observations=el('section');
 root.append(heading,el('p',{class:'dim'},'Reduced timeline fields only: source, category, name, recorded severity, tool metadata and count. Intervals exclude the baseline and include the closing recurrence. Labels may be truncated or opaque; the exact token comparison determines match status. Matching does not prove identical commands, strategy, retries or success.'),el('p',{},comparison.equal?'Same recorded runs and counts.':'Recorded runs or counts differ.'),content,observations);
 function button(text:string,action:()=>void,key:string){const b=el('button',{'data-key':key},text);b.onclick=action;return b;}
 function closeRun(){cancel();clear(observations);}
 /** Status stays mounted while page controls and rows change. */
 function paged(host:HTMLElement,total:number,name:string,fallback:HTMLElement,render:(body:HTMLElement,start:number,end:number)=>void){
  const status=el('p',{role:'status'}),body=el('div');host.append(status,body);let page=0;
  function draw(){clear(body);const start=page*40,end=Math.min(total,start+40);status.textContent=`${name}: ${total?start+1:0}–${end} of ${total}`;render(body,start,end);
   if(total<=40)return;
   const previous=button(`Previous ${name}`,()=>move(-1,`Previous ${name}`),`sequence:page:${name}:previous`),next=button(`Next ${name}`,()=>move(1,`Next ${name}`),`sequence:page:${name}:next`);previous.disabled=page===0;next.disabled=end===total;body.append(previous,next);
  }
  function move(delta:number,text:string){cancel();if(name!=='run observations')clear(observations);page+=delta;draw();const target=[...body.querySelectorAll('button')].find(b=>b.textContent===text&&!b.disabled);(target??fallback).focus();}
  draw();
 }
 function openRun(run:SequenceRun,side:string,opener:HTMLElement){closeRun();const title=el('h4',{tabindex:'-1'},`Run observations — ${side}`);observations.append(title,button('Close run observations',()=>{closeRun();(opener.isConnected?opener:heading).focus();},'sequence:close'));
  paged(observations,run.events.length,'run observations',title,(body,start,end)=>{const list=el('ol',{start:String(start+1)});for(let i=start;i<end;i++){const event=run.events[i];list.append(el('li',{},button(`Inspect observation ${label(event.time)} · ${label(event.id)}`,()=>inspect(event),`sequence:event:${side}:${i}`)));}body.append(list);});title.focus();
 }
 function runContent(run:SequenceRun,side:string,index:number){return el('div',{},el('p',{},`${label(run.source)} · ${label(run.category)} · ${label(run.name)} · severity: ${label(run.severity)} · tool: ${label(run.tool)} · ${run.events.length} observations${run.closing?' · includes closing recurrence':''}`),button(`Browse ${side} run ${index+1}`,()=>openRun(run,side,root.querySelector<HTMLElement>(`[data-key="sequence:run:${side}:${index}"]`)!),`sequence:run:${side}:${index}`));}
 if(comparison.rows){
  const rows=comparison.rows;
  const aIndexes=new Map(comparison.a.map((run,i)=>[run,i])),bIndexes=new Map(comparison.b.map((run,i)=>[run,i]));
  paged(content,rows.length,'comparison rows',heading,(host,start,end)=>{const table=el('table');table.append(el('caption',{},'Exact run alignment'),el('thead',{},el('tr',{},el('th',{scope:'col'},'Status'),el('th',{scope:'col'},'A'),el('th',{scope:'col'},'B'))));const body=el('tbody');
   for(let i=start;i<end;i++){const row=rows[i];body.append(el('tr',{},el('th',{scope:'row'},row.kind),el('td',{},row.a?runContent(row.a,'A',aIndexes.get(row.a)!):'—'),el('td',{},row.b?runContent(row.b,'B',bIndexes.get(row.b)!):'—')));}table.append(body);host.append(table);
  });
 }else{
  content.append(el('p',{},'Alignment unavailable: one sequence exceeds 200 runs. Complete sequences remain paginated; equality above uses all runs.'));
  for(const [side,runs]of [['A',comparison.a],['B',comparison.b]] as const){const section=el('section',{'aria-label':`${side} runs`});section.append(el('h4',{},`${side} recorded runs`));paged(section,runs.length,`${side} runs`,heading,(host,start,end)=>{const list=el('ol',{start:String(start+1)});for(let i=start;i<end;i++)list.append(el('li',{},runContent(runs[i],side,i)));host.append(list);});content.append(section);}
 }
 return root;
}
