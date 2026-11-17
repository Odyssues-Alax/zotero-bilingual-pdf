// Deterministic checks run on every output before the PDF can be saved.
// These checks prove geometry and coverage accounting, not translation meaning.
import {symbolSummary} from "./symbols.mjs";
import {problem,uniqueIssues} from "./issues.mjs";
export const QUALITY_VERSION="1.1.0";
const overlap=(a,b)=>({w:Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h:Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))});
// Compare source lines independently of translated boxes. A model region
// constrains the comparison; separate columns/regions are not joined here.
function auditLineOwnership(page){
 const regions=new Map(),issues=[];
 for(const block of page.blocks){
  const region=block.modelRegion;
  if(!region?.id||!["plain text","figure_caption","table_caption"].includes(region.role)||
   block.protectedFormula||["table","formula","references","metadata","running"].includes(block.role))continue;
  if(!regions.has(region.id))regions.set(region.id,[]);
  for(const line of block.lines||[]){
   if(!Number.isFinite(line.baseline)||!(line.parts||[]).some(part=>/[A-Za-z]{2}/.test(part.text)))continue;
   regions.get(region.id).push({block,line});
  }
 }
 for(const rows of regions.values()){
  rows.sort((a,b)=>a.line.baseline-b.line.baseline);
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
   const a=rows[i],b=rows[j];
   if(b.line.baseline-a.line.baseline>=.45)break;
   if(a.block===b.block||!a.block.selected&&!b.block.selected)continue;
   const x=a.line,y=b.line,gap=Math.max(x.x-y.x-y.w,y.x-x.x-x.w);
   if(gap>Math.min(x.fs,y.fs)*.8)continue;
   issues.push(problem("source_structure","第 "+page.number+" 页同一行原文分属两个区域，需检查行归属后再翻译。",[a.block.id,b.block.id]));
  }
 }
 return issues;
}
export function auditSource(pages){
 const issues=[],ids=new Set();
 for(const p of pages){const owned=p.blocks.flatMap(b=>(b.lines||[]).flatMap(l=>(l.parts||[]).map(v=>v.sourceIndex).filter(Number.isInteger))),actual=new Set(owned);
  if(owned.length!==actual.size)issues.push(problem("source_structure","原文项存在重复归属，需要检查页面结构。",p.blocks.map(b=>b.id)));
  if(p.sourceIndices?.some(i=>!actual.has(i)))issues.push(problem("source_structure","有可处理原文项未归入任何区域，已停止生成。",p.blocks.map(b=>b.id)));
  issues.push(...auditLineOwnership(p));
  for(const b of p.blocks){if(ids.has(b.id))issues.push(problem("source_structure","原文区域编号重复。",[b.id]));ids.add(b.id);}
 }
 return uniqueIssues(issues);
}
export function auditPlan(page,layouts,translations){
 const issues=[],occupied=[];
 for(const b of page.blocks.filter(b=>b.selected)){
  const l=layouts.get(b.id);if(!translations[b.id]||!l){issues.push(problem("translation_missing","排版检查发现选中段落缺少完整译文或排版结果。",[b.id]));continue;}
  const flow=page.structure?.flows.find(f=>f.id===b.flowID);
  for(let i=0;i<l.lines.length;i++){
   const r={id:b.id,x:l.lineXs?.[i]??l.x,y:l.y+(l.lineOffsets?.[i]??i*l.leading)+l.ink[i].top,w:l.lines[i].reduce((n,u)=>n+u.width,0),h:l.ink[i].bottom-l.ink[i].top};
   if(!Number.isFinite(r.x+r.y+r.w+r.h)||r.x<-.1||r.y<-.1||r.x+r.w>page.width+.1||r.y+r.h>page.height+.1)issues.push(problem("layout_bounds","译文字形越过页面边界，已阻止保存。",[b.id]));
   if(flow&&(r.x<flow.x-.1||r.x+r.w>flow.x+flow.w+.1))issues.push(problem("source_structure","译文越过所属栏位，需检查区域。",[b.id]));
   for(const q of occupied){const o=overlap(r,q);if(o.w>Math.min(r.w,q.w)*.25&&o.h>Math.min(r.h,q.h)*.25)issues.push(problem("layout_overlap",q.id===b.id?"同一段落内两行字形相互覆盖，需调整行距。":"段落字形相互覆盖，需检查整栏排版。",[b.id,q.id]));}
   occupied.push(r);
  }
 }
 return uniqueIssues(issues);
}
export function qualitySummary(pages,translations,layouts,issues=[]){
 const selected=pages.flatMap(p=>p.blocks.filter(b=>b.selected)),rows=pages.map(p=>{
  const bs=p.blocks.filter(b=>b.selected),values=bs.map(b=>layouts[b.id]).filter(Boolean);
  return {page:p.number,selected:bs.length,translated:bs.filter(b=>typeof translations[b.id]==="string").length,planned:values.length,smallestFont:values.length?Math.min(...values.map(v=>v.size)):null,moved:bs.filter(b=>layouts[b.id]&&Math.abs(layouts[b.id].y-b.y)>2).length};
 });
 return {version:QUALITY_VERSION,symbols:symbolSummary(pages),pages:rows,selected:selected.length,translated:selected.filter(b=>typeof translations[b.id]==="string").length,unresolved:issues.length,unconfirmedLinks:pages.structure?.candidates.length||0,unconfirmedRegions:pages.structure?.uncertainNodes.length||0,checks:["源项唯一归属","完整段落与译文标记","异常编码及数值、正负号、单位","页数及页面尺寸","真实字形边界和行间重叠","公式、图片及保留原文碰撞"],limits:"机检不等于译义人工审校，也不能识别全部未知PDF绘图指令。"};
}
