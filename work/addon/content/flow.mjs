import {classify,issuesError} from "./issues.mjs";
import {translate,validateParagraph,scientificLabel} from "./core.mjs";
export function logicalJobs(blocks){
  const grouped=new Map();
  for(const b of blocks){const id=b.paragraphID||b.id;if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(b);}
  return [...grouped.values()].map(members=>{
    if(members.length===1)return members[0];
    members.sort((a,b)=>(a.readingIndex??(a.page*1000000+a.column*10000+a.y))-(b.readingIndex??(b.page*1000000+b.column*10000+b.y)));
    const math={},tokenMap={};let serial=0;
    const fragments=members.map(b=>({id:b.id,text:b.text.replace(/⟦M\d+⟧/g,local=>{
      const global='⟦M'+(++serial)+'⟧';math[global]=b.math[local];tokenMap[global]={id:b.id,local};return global;
    })}));
    const text=fragments.map(f=>f.text).join(' ').replace(/- ([a-z])/g,'-$1');
    return {id:'paragraph-'+members[0].id,text,math,members,tokenMap,fragments,mathTokenGroups:fragments.map(f=>({id:f.id,tokens:f.text.match(/⟦M\d+⟧/g)||[]})),paragraphID:members[0].paragraphID};
  });
}
export function splitLogical(job,text){
  text=validateParagraph(job,text);
  if(!job.members)return {[job.id]:text};
  const members=job.members,units=text.match(/⟦M\d+⟧|[A-Za-z0-9]+(?:[./+\-][A-Za-z0-9]+)*|[\s\S]/gu)||[];
  const owner=new Map(members.map((b,i)=>[b.id,i]));
  const weights=members.map(b=>b.text.replace(/⟦M\d+⟧/g,'x').length),total=weights.reduce((a,b)=>a+b,0);
  const needsChinese=b=>/[A-Za-z]{3}/.test(b.text)&&!scientificLabel(b.text);
  const cuts=[0];let sum=0;
  for(let i=0;i<members.length-1;i++){
    sum+=weights[i];let lower=cuts.at(-1)+1,upper=units.length-(members.length-i-1);
    for(let j=0;j<units.length;j++)if(job.tokenMap[units[j]]){
      const index=owner.get(job.tokenMap[units[j]].id);
      if(index<=i)lower=Math.max(lower,j+1);else upper=Math.min(upper,j);
    }
    if(lower>upper)throw new Error('完整段落 '+job.id+' 的公式顺序无法安全放回原区域，请重试；已保留草稿。');
    const target=Math.max(lower,Math.min(upper,Math.round(units.length*sum/total)));
    let cut=target,best=Infinity;
    for(let j=Math.max(lower,target-18);j<=Math.min(upper,target+18);j++){
      if(/^[，。、；：！？）》】]/.test(units[j]||''))continue;
      if(needsChinese(members[i])&&!/[\u3400-\u9fff]/.test(units.slice(cuts.at(-1),j).join('')))continue;
      const required=members.slice(i+1).filter(needsChinese).length;
      if((units.slice(j).join('').match(/[\u3400-\u9fff]/g)||[]).length<required)continue;
      const score=Math.abs(j-target)+(/[，。；：！？、\s]$/.test(units[j-1])?0:6);
      if(score<best){best=score;cut=j;}
    }
    if(!Number.isFinite(best))throw Object.assign(new Error('完整段落的中文尾句无法安全分配到各片段，请保留完整草稿后重试。'),{code:'translation_english'});
    cuts.push(cut);
  }
  cuts.push(units.length);
  const result={};
  for(let i=0;i<members.length;i++){
    const b=members[i];
    const value=units.slice(cuts[i],cuts[i+1]).join('').replace(/⟦M\d+⟧/g,t=>{
      if(job.tokenMap[t]?.id!==b.id)throw new Error('公式分配失败，未采用本段译文。');
      return job.tokenMap[t].local;
    }).trim();
    result[b.id]=validateParagraph({...b,paragraphSource:b.paragraphSource||job.text},value);
  }
  return result;
}
export async function translateLogical(blocks,settings,key,signal,translator=translate,policy=null){
  const jobs=logicalJobs(blocks),output={};
  let translated;
  try{translated=await translator(jobs,settings,key,signal,undefined,policy);}catch(error){
    const partial={},drafts={},paragraphDrafts={};
    for(const job of jobs){
      if(error.partial?.[job.id])try{Object.assign(partial,splitLogical(job,error.partial[job.id]));}catch(_){paragraphDrafts[job.id]={text:error.partial[job.id],source:job.text};}
      if(typeof error.drafts?.[job.id]==='string'){
        if(job.members)paragraphDrafts[job.id]={text:error.drafts[job.id],source:job.text};
        else drafts[job.id]=error.drafts[job.id];
      }
    }
    const mapped=(error.issues||[classify(error,[error.blockID].filter(Boolean))]).map(issue=>({...issue,blockIDs:issue.blockIDs.flatMap(id=>{const j=jobs.find(j=>j.id===id);return j?.members?j.members.map(b=>b.id):[id];})}));
    error.issues=mapped;
    const failed=jobs.find(j=>j.id===error.blockID);
    error.partial=partial;error.drafts=drafts;error.paragraphDrafts=paragraphDrafts;
    if(failed?.members)error.blockID=failed.members[0].id;
    throw error;
  }
  let failure=null;const issues=[];
  const paragraphDrafts={},drafts={};
  for(const job of jobs){
    try{Object.assign(output,splitLogical(job,translated[job.id]));}
    catch(error){
      issues.push(classify(error,job.members?.map(b=>b.id)||[job.id]));
      if(!failure){failure=error;failure.blockID=job.members?.[0].id||job.id;}
      if(job.members)paragraphDrafts[job.id]={text:translated[job.id],source:job.text};
      else drafts[job.id]=translated[job.id];
    }
  }
  if(failure){failure.issues=issues;failure.blockIDs=issues.flatMap(i=>i.blockIDs);failure.partial=output;failure.paragraphDrafts=paragraphDrafts;failure.drafts=drafts;throw failure;}
  return output;
}
