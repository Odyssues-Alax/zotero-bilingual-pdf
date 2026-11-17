// Recovery reuses only exact source/context matches and never overwrites a
// valid manual edit. Whole logical drafts are adopted atomically.
import {logicalJobs,splitLogical} from "./flow.mjs";
import {translationCurrent} from "./document.mjs";
import {fingerprint,recovery,POLICY_REVISION} from "./issues.mjs";
export function recoverDrafts(pages,cache){
 const accepted=[];
 for(const job of logicalJobs(pages.flatMap(p=>p.blocks).filter(b=>b.selected))){
  const members=job.members||[job],draft=job.members?cache.paragraphDrafts?.[job.id]:cache.drafts?.[job.id];
  if(draft?.source!==job.text||members.every(b=>translationCurrent(b,cache.translations[b.id]))||members.some(b=>cache.translations[b.id]?.manual&&translationCurrent(b,cache.translations[b.id])))continue;
  try{
   const values=splitLogical(job,draft.text);
   for(const b of members){cache.translations[b.id]={source:b.text,text:values[b.id],paragraphSource:b.paragraphSource,continuous:1,revalidated:true};delete cache.drafts[b.id];accepted.push(b.id);}
   if(job.members)delete cache.paragraphDrafts[job.id];
  }catch{}
 }
 const done=new Set(pages.flatMap(p=>p.blocks).filter(b=>translationCurrent(b,cache.translations[b.id])).map(b=>b.id));
 const store=recovery(cache);store.issues=store.issues.map(i=>i.stage==="translation"&&!i.service?{...i,blockIDs:i.blockIDs.filter(id=>!done.has(id))}:i).filter(i=>i.service||i.blockIDs.length);
 return accepted;
}
export function repairStamp(pages,cache,ids=null){
 const selected=pages.flatMap(p=>p.blocks).filter(b=>b.selected&&(!ids||ids.includes(b.id)));
 return fingerprint([POLICY_REVISION,pages.structure?.candidates.map(e=>[e.id,e.stamp]),pages.structure?.uncertainNodes.map(n=>[n.id,n.stamp]),selected.map(b=>[b.id,b.text,b.paragraphSource,b.role,b.flowID,cache.translations[b.id],cache.drafts[b.id],cache.layoutOverrides?.[b.id]]),cache.paragraphDrafts,cache.structureDecisions?.labels,cache.structureDecisions?.links,recovery(cache).issues.filter(i=>!ids||i.blockIDs.some(id=>ids.includes(id))).map(i=>[i.code,i.detail,i.blockIDs])]);
}
