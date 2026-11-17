import {logicalJobs} from "./flow.mjs";
import {translationCurrent} from "./document.mjs";
// A physical page fragment and its logical continuation share one draft source.
// Return only exact current-source/context matches, never guess from block IDs.
export function resolveDraft(pages,cache,block){
  const members=pages.flatMap(p=>p.blocks).filter(b=>(b.paragraphID||b.id)===(block.paragraphID||block.id));
  const job=logicalJobs(members)[0]||block;
  const translated=cache.translations?.[block.id];
  const current=translationCurrent(block,translated);
  if(current&&(translated.manual||members.every(b=>translationCurrent(b,cache.translations?.[b.id]))))return {scope:"region",job:block,source:block.text,text:translated.text,entry:translated};
  const full=cache.paragraphDrafts?.[job.id];
  if(job.members&&full?.source===job.text&&typeof full.text==="string")return {scope:"paragraph",job,source:job.text,text:full.text,entry:full};
  if(current)return {scope:"region",job:block,source:block.text,text:translated.text,entry:translated};
  const draft=cache.drafts?.[block.id];
  if(draft?.source===block.text&&(!draft.paragraphSource||draft.paragraphSource===block.paragraphSource)&&typeof draft.text==="string")return {scope:"region",job:block,source:block.text,text:draft.text,entry:draft};
  return null;
}
