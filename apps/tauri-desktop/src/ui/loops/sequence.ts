import type {FirehoseEvent} from "../../api";
export type SequenceRun={key:string;source:string;category:string;name:string;severity:string;tool:string;events:FirehoseEvent[];closing:boolean};
function canonical(value:unknown):string {
 if(value===undefined)return '["missing"]';
 if(value===null||typeof value!=="object")return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 const object=value as Record<string,unknown>;return `{${Object.keys(object).sort().map(k=>`${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
}
/** Existing Loop order; excludes baseline and includes closing recurrence. */
export function sequenceRuns(events:readonly FirehoseEvent[],fromIndex:number,toIndex:number):SequenceRun[]{
 const runs:SequenceRun[]=[];
 for(let i=fromIndex+1;i<=toIndex&&i<events.length;i++){
  const event=events[i],tool=event.payload?.tool_name;
  const key=JSON.stringify([event.source,event.category,event.name,event.severity,[tool===undefined?"missing":"recorded",canonical(tool)]]);
  const previous=runs.at(-1);
  if(previous?.key===key){previous.events.push(event);previous.closing=i===toIndex;}
  else runs.push({key,source:event.source,category:event.category,name:event.name??"Not recorded",severity:event.severity??"Not recorded",tool:typeof tool==='string'?tool:'Unavailable',events:[event],closing:i===toIndex});
 }
 return runs;
}
export type SequenceRow={kind:'match'|'only-A'|'only-B';a?:SequenceRun;b?:SequenceRun};
export type SequenceComparison={a:SequenceRun[];b:SequenceRun[];equal:boolean;rows:SequenceRow[]|undefined};
const same=(a:SequenceRun,b:SequenceRun)=>a.key===b.key&&a.events.length===b.events.length;
/** Quadratic work is restricted to <=200 runs per side; equality uses all runs. */
export function compareSequences(a:SequenceRun[],b:SequenceRun[]):SequenceComparison{
 const result:SequenceComparison={a,b,equal:a.length===b.length&&a.every((run,i)=>same(run,b[i])),rows:undefined};
 if(a.length>200||b.length>200)return result;
 const matrix=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)matrix[i][j]=same(a[i],b[j])?1+matrix[i+1][j+1]:Math.max(matrix[i+1][j],matrix[i][j+1]);
 const rows:SequenceRow[]=[];let i=0,j=0;
 while(i<a.length||j<b.length){
  if(i<a.length&&j<b.length&&same(a[i],b[j]))rows.push({kind:'match',a:a[i++],b:b[j++]});
  else if(i<a.length&&(j===b.length||matrix[i+1][j]>=matrix[i][j+1]))rows.push({kind:'only-A',a:a[i++]});
  else rows.push({kind:'only-B',b:b[j++]});
 }
 result.rows=rows;return result;
}
