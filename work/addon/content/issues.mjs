import {sourceSymbolIssues} from "./symbols.mjs";
// Persistent recovery is scoped to this document cache, never to API credentials.
export const RECOVERY_VERSION="1.0.18";
export const MAX_ATTEMPTS=2;
export const POLICY_REVISION="1.2.8";
export function fingerprint(value){
  const s=typeof value==="string"?value:JSON.stringify(value);let a=2166136261,b=5381;
  for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b,33)^s.charCodeAt(i);}
  return (a>>>0).toString(16)+"-"+(b>>>0).toString(16)+"-"+s.length;
}
export function recovery(cache){
  if(cache.recovery?.version!==RECOVERY_VERSION)cache.recovery={version:RECOVERY_VERSION,attempts:{},issues:[],layout:null,service:null};
  return cache.recovery;
}
export function jobStamp(job){return fingerprint([POLICY_REVISION,job.text,job.members?.map(b=>[b.id,b.text]),Object.keys(job.math||{})]);}
export function attemptsFor(store,job){const a=store.attempts[job.id];return a?.stamp===jobStamp(job)?a.count:0;}
export function canAttempt(store,job){return !store.service&&attemptsFor(store,job)<MAX_ATTEMPTS;}
export function reserveAttempt(store,job){
  if(!canAttempt(store,job))return false;
  store.attempts[job.id]={stamp:jobStamp(job),count:attemptsFor(store,job)+1};return true;
}
export function resetAttempts(store,jobs){for(const j of jobs)delete store.attempts[j.id];store.service=null;}
export function classify(error,blockIDs=[]){
  const text=error?.message||String(error);let code=error?.code,stage=error?.stage||"translation";
  if(!code){
    if(/API Key|401|403/.test(text))code="service_auth";
    else if(/HTTP 429/.test(text))code="service_rate";
    else if(/HTTP 5\d\d/.test(text))code="service_server";
    else if(/HTTP/.test(text))code="service_config";
    else if(/无法连接|网络/.test(text))code="service_network";
    else if(/超时/.test(text))code="service_timeout";
    else if(/字体|字符.*U\+/.test(text))code="font_missing";
    else if(/覆盖公式/.test(text))code="layout_formula";
    else if(/覆盖保留/.test(text))code="layout_retained";
    else if(/重叠/.test(text))code="layout_overlap";
    else if(/放不进/.test(text))code="layout_space";
    else if(/跨越两栏|跨栏文本|归组/.test(text))code="source_structure";
    else if(/公式|占位符/.test(text))code="translation_math";
    else if(/英文|未返回中文/.test(text))code="translation_english";
    else if(/JSON/.test(text))code="translation_format";
    else if(/长度/.test(text))code="translation_length";
    else if(/缺少|数量/.test(text))code="translation_missing";
    else code="unknown";
  }
  if(code.startsWith("layout_")||code==="font_missing")stage="layout";
  if(code==="source_structure"||code==="source_symbol")stage="preflight";
  return {code,stage,message:text,detail:error?.detail||"",evidence:error?.evidence,blockIDs:[...new Set(error?.blockIDs||blockIDs)],retryable:code.startsWith("translation_")||code.startsWith("service_"),service:code.startsWith("service_")};
}
export function problem(code,message,blockIDs=[],detail=""){return classify({code,message,detail},blockIDs);}
export function groupedIssues(issues){
  const groups=new Map();
  for(const v of issues){const key=v.code+"|"+(v.code==="font_missing"?v.detail:"");if(!groups.has(key))groups.set(key,{...v,blockIDs:[],occurrences:0});const g=groups.get(key);g.occurrences++;if(g.detail!==v.detail)g.detail="";g.blockIDs.push(...v.blockIDs);}
  return [...groups.values()].map(g=>({...g,blockIDs:[...new Set(g.blockIDs)]}));
}
export function issuesError(issues){
  const e=new Error("发现 "+groupedIssues(issues).length+" 类问题，涉及 "+new Set(issues.flatMap(i=>i.blockIDs)).size+" 个段落；有效译文已保存，请打开“问题列表”。首项："+(issues[0]?.message||""));
  e.issues=issues;e.blockIDs=[...new Set(issues.flatMap(i=>i.blockIDs))];return e;
}
export function sourcePreflight(pages){
  const issues=[];
  for(const p of pages)for(const b of p.blocks.filter(b=>b.selected)){
    if(!Number.isFinite(b.x+b.y+b.w+b.h)||b.w<=0||b.h<=0||b.x< -2||b.y< -2||b.x+b.w>p.width+2||b.y+b.h>p.height+2)
      issues.push(problem("source_structure","原文段落坐标异常，需要检查识别区域。",[b.id]));
    if(b.reason==="跨栏文本")issues.push(problem("source_structure","原文段落疑似跨越两栏，不能安全替换。",[b.id]));
  }
  issues.push(...sourceSymbolIssues(pages),...(pages.structure?.issues||[]));
  return issues;
}
export function layoutStamp(pages,translations){return fingerprint(pages.map(p=>[p.number,p.width,p.height,p.structure?.version,p.visualRegions,p.blocks.map(b=>[b.id,b.selected,b.x,b.y,b.w,b.h,b.fs,b.math,b.lines,b.layoutOverride||null,b.flowID,b.role,translations[b.id]||null])]));}
export const titles={source_symbol:"原文符号待确认",translation_symbol:"译文异常编码",translation_science:"译文数值需要核对",translation_identifier:"材料或样品编号需要核对",font_missing:"缺少可用字形",source_structure:"原文结构待检查",layout_image:"译文与图片冲突",layout_bounds:"译文超出页面",layout_space:"译文空间不足",layout_overlap:"译文相互重叠",layout_formula:"译文与公式冲突",layout_retained:"译文与保留原文冲突",translation_english:"残留英文或未返回中文",translation_math:"公式标记不一致",translation_missing:"缺失段落",translation_format:"返回格式不完整",translation_length:"服务输出被截断",service_auth:"服务认证失败",service_rate:"服务限流",service_server:"服务暂时不可用",service_network:"服务连接失败",service_timeout:"请求超时",service_config:"服务配置错误",unknown:"待检查问题"};

export function uniqueIssues(issues){return [...new Map(issues.map(i=>[i.code+"|"+i.detail+"|"+[...i.blockIDs].sort().join(","),i])).values()];}
