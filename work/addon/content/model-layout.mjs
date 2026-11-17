import {containsEmail} from "./source-text.mjs";
// Model boxes constrain ownership; they do not supply text or replacement coordinates.
import {segment} from "./core.mjs";
export const MODEL_LAYOUT_VERSION="1.2.0-layout1";
const area=r=>Math.max(.01,r.w*r.h);
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
const captions=new Set(["figure_caption","table_caption"]),protectedRoles=new Set(["figure","table","isolate_formula","formula_caption","abandon"]);

const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
function proseLines(items){
 const size=median(items.filter(v=>/[A-Za-z]{2,}/.test(v.item.str)).map(v=>v.fs));
 const rows=[];
 for(const item of items){
  if(item.fs<size*.84||item.fs>size*1.25)continue;
  let row=rows.at(-1);
  if(!row||Math.abs(row.baseline-item.baseline)>size*.28){
   row={baseline:item.baseline,fs:item.fs,items:[]};
   rows.push(row);
  }
  row.items.push(item);
 }
 return rows.map(row=>({...row,text:textOf(row.items)})).filter(row=>(row.text.match(/[A-Za-z]{2,}/g)||[]).length>=2);
}
const textOf=items=>items.map(v=>v.item.str).join(" ");
const span=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));

function wrappedAbstract(assigned,regions,blocks,content,viewport,pdfjs,pageNumber,options){
 if(pageNumber!==1)return null;
 const textRegions=regions.filter(r=>r.role==="plain text"&&r.confidence>=.55);
 const figures=regions.filter(r=>r.role==="figure"&&r.confidence>=.55);
 const candidates=[];
 for(const left of textRegions){
  const top=assigned.filter(v=>v.owner===left);
  if(!/^\s*abstract\b/i.test(textOf(top)))continue;
  const proseTop=proseLines(top);
  if(proseTop.length<4)continue;
  const tail=proseTop.at(-1),fs=median(proseTop.map(v=>v.fs));
  if(/[.!?;:][)"'\]\s]*$/.test(tail.text.trim()))continue;
  for(const figure of figures){
   const bottom=figure.y+figure.h;
   if(left.x+left.w>figure.x+fs||figure.x-left.x-left.w>fs*4||Math.abs(left.y+left.h-bottom)>fs*1.8)continue;
   if(Math.min(left.y+left.h,bottom)-Math.max(left.y,figure.y)<left.h*.55)continue;
   for(const lower of textRegions){
    if(lower===left||lower.w<left.w*1.35||Math.abs(lower.x-left.x)>fs||Math.abs(lower.y-bottom)>fs*2.1||lower.x+lower.w<figure.x+figure.w*.4)continue;
    const below=assigned.filter(v=>v.owner===lower);
    const head=proseLines(below)[0];
    if(!head||!/^[a-z([]/.test(head.text.trim())||head.baseline<=tail.baseline||head.baseline-tail.baseline>fs*2.2||Math.abs(head.fs-fs)>fs*.22)continue;
    const first=assigned.indexOf(top[0]),split=assigned.indexOf(below[0]),last=assigned.indexOf(below.at(-1));
    if(first<0||split<=first||last<split||last-first>400)continue;
    const source=assigned.slice(first,last+1);
    // The content-stream run must own the entire passage, including short
    // inline items, with no intervening caption, keyword, or foreign text.
    if(!top.every(v=>source.includes(v))||!below.every(v=>source.includes(v)))continue;
    if(source.some((v,i)=>{
     const target=first+i<split?left:lower;
     return (v.owner&&v.owner!==target)||v.baseline<target.y-2||v.baseline>target.y+target.h+3||
       span(v.ink,target)<v.ink.w*.70||overlap(v.ink,figure)>area(v.ink)*.15;
    }))continue;
    if(!/[.!?][)”'\]\s]*$/.test(textOf(below).trim())||/\b(?:keywords?|index terms)\s*:/i.test(textOf(source)))continue;
    const indices=new Set(source.map(v=>v.item.zbpSourceIndex));
    const replaced=blocks.filter(b=>b.lines.some(l=>l.parts.some(p=>indices.has(p.sourceIndex))));
    if(replaced.some(b=>b.protectedFormula||options.preserve?.(b)||b.lines.some(l=>l.parts.some(p=>!indices.has(p.sourceIndex)))))continue;
    const items=source.map(v=>v.item);
    const pieces=segment({...content,items},{...viewport,zbpWrappedAbstract:true},pdfjs,pageNumber);
    if(pieces.length!==1||pieces[0].protectedFormula||pieces[0].lines.some(l=>l.crossColumn||l.table))continue;
    const merged=pieces[0];
    const count=merged.lines.reduce((n,l)=>n+l.parts.length,0);
    if(count!==indices.size)continue;
    merged.id=replaced[0].id;
    merged.wrappedAbstract={figure:{...figure},sourceCount:count};
    merged.baseClassification={selected:true,reason:"",kind:"正文"};
    Object.assign(merged,merged.baseClassification);
    candidates.push({merged,replaced});
   }
  }
 }
 return candidates.length===1?candidates[0]:null;
}

// A large image spanning both the text and a separate illustration is the
// abstract panel background. Keep the actual illustration as the obstacle.
export function layoutObstacles(regions,blocks){
 const backgrounds=new Set();
 const images=regions.filter(r=>r.kind==="image");
 for(const block of blocks){
  if(!block.wrappedAbstract)continue;
  const figure=block.wrappedAbstract.figure;
  for(const panel of images){
   if(panel.w<block.w*.98||panel.w<figure.w*1.35||panel.h<block.h*.96||
    overlap(panel,block)<area(block)*.95||overlap(panel,figure)<area(figure)*.98)continue;
   backgrounds.add(panel);
   // Publishers may paint the upper and lower edges of a panel as separate
   // strips. Require matching panel width and contact at an outer edge.
   for(const strip of images){
    if(Math.abs(strip.x-panel.x)>1||Math.abs(strip.w-panel.w)>2||strip.h>block.fs*4)continue;
    const touchesTop=strip.y<panel.y&&Math.abs(strip.y+strip.h-panel.y)<=block.fs;
    const touchesBottom=strip.y+strip.h>panel.y+panel.h&&Math.abs(strip.y-panel.y-panel.h)<=block.fs;
    if(touchesTop||touchesBottom)backgrounds.add(strip);
   }
  }
 }
 return regions.filter(r=>!backgrounds.has(r));
}
function protectTableNotes(blocks,regions){
 const tables=regions.filter(r=>r.role==="table"&&r.confidence>=.55);
 for(const b of blocks){
  const region=b.modelRegion;
  if(!region||!(region.role==="table_footnote"&&region.confidence>=.65||
   region.role==="plain text"&&/^(?:Table\s+)?Notes?\s*:/i.test(b.text)))continue;
  const table=tables.find(r=>Math.abs(b.y-r.y-r.h)<=b.fs*1.5&&span(b,r)>=b.w*.85&&b.w>=r.w*.65);
  if(!table)continue;
  for(const note of blocks.filter(n=>n.modelRegion?.id===b.modelRegion.id&&n.y>=b.y-1)){
   note.baseClassification={selected:false,reason:"表格注释",kind:"正文"};
   Object.assign(note,note.baseClassification);
  }
 }
}

export function segmentWithModel(content,viewport,pdfjs,pageNumber,modelPage,options={}){
 if(!modelPage||Math.abs(modelPage.width-viewport.width)>.5||Math.abs(modelPage.height-viewport.height)>.5)throw new Error("版面模型的页面尺寸不一致，请重新识别。");
 // Duplicate nested caption detections can steal a superscript from the
 // complete caption. Use the encompassing box only when containment proves
 // they describe the same caption; adjacent captions retain separate owners.
 const candidates=modelPage.regions.filter(r=>r.confidence>=.35);
 const regions=candidates.filter(r=>!captions.has(r.role)||!candidates.some(other=>other!==r&&captions.has(other.role)&&area(other)>area(r)*1.05&&overlap(r,other)/area(r)>=.9)),groups=new Map(),expected=[],assigned=[];
 for(const [index,item] of content.items.entries()){
  if(!item.str?.trim())continue;const t=pdfjs.Util.transform(viewport.transform,item.transform);
  if(Math.abs(t[1])>Math.abs(t[0])*.15)continue;expected.push(index);
  const style=content.styles[item.fontName]||{},fs=Math.hypot(t[2],t[3])||item.height||10;
  const ascent=Number.isFinite(style.ascent)&&style.ascent>0?style.ascent:.8,descent=Number.isFinite(style.descent)?style.descent:-.25;
  const ink={x:t[4],y:t[5]-fs*ascent,w:Math.abs(item.width),h:Math.max(fs*.6,fs*(ascent-descent))};
  const candidates=regions.map(r=>({r,ratio:overlap(ink,r)/area(ink)})).filter(v=>v.ratio>=.4);
  // Captions take priority over a loose image box; independent formulas stay protected.
  candidates.sort((a,b)=>score(b)-score(a));
  function score(v){return v.ratio+(captions.has(v.r.role)?2:v.r.role==="isolate_formula"&&v.r.confidence>.55?1.5:protectedRoles.has(v.r.role)?.15:.4)+v.r.confidence*.1-area(v.r)/area({w:viewport.width,h:viewport.height})*.05;}
  const owner=candidates[0]?.r||null;
  assigned.push({item:{...item,zbpSourceIndex:index},owner,ink,baseline:t[5],fs});
 }
 // Model boxes sometimes omit the leading label/left half of a full-width
 // caption. Reclaim only unassigned, contiguous same-baseline source items;
 // never steal from another model region or bridge a visible column gutter.
 const textRoles=new Set(["title","plain text","figure_caption","table_caption"]);
 for(const v of assigned.filter(v=>!v.owner&&v.item.str.trim().length<=28&&!/[A-Za-z]{3,}/.test(v.item.str))){
  const candidates=assigned.filter(a=>a.owner&&textRoles.has(a.owner.role)&&v.fs<a.fs*.93&&Math.abs(a.baseline-v.baseline)<a.fs*.8&&Math.max(a.ink.x-v.ink.x-v.ink.w,v.ink.x-a.ink.x-a.ink.w)<a.fs*1.5).sort((a,b)=>Math.max(a.ink.x-v.ink.x-v.ink.w,v.ink.x-a.ink.x-a.ink.w)-Math.max(b.ink.x-v.ink.x-v.ink.w,v.ink.x-b.ink.x-b.ink.w)||Math.abs(a.baseline-v.baseline)-Math.abs(b.baseline-v.baseline));
  if(candidates[0])v.owner=candidates[0].owner;
 }
 let frontier=assigned.filter(v=>v.owner&&captions.has(v.owner.role));
 while(frontier.length){
  const next=[];
  for(const v of assigned.filter(v=>!v.owner)){
   const anchor=frontier.find(a=>Math.abs(a.baseline-v.baseline)<Math.min(a.fs,v.fs)*.3&&Math.abs(a.fs-v.fs)<Math.max(a.fs,v.fs)*.35&&Math.max(a.ink.x-v.ink.x-v.ink.w,v.ink.x-a.ink.x-a.ink.w)<Math.max(a.fs,v.fs)*1.8);
   if(anchor){v.owner=anchor.owner;next.push(v);}
  }
  frontier=next;
 }
 for(const {item,owner} of assigned){const key=owner?.id||"unassigned";if(!groups.has(key))groups.set(key,{region:owner,items:[]});groups.get(key).items.push(item);}
 const blocks=[];
 for(const {region,items} of groups.values()){
  const groupText=items.map(i=>i.str).join(" ");
  const publication=/copyright|©|all rights reserved|^\s*(?:Licensee |Citation:|Academic Editor:)|https?:\/\/|doi\.org|creativecommons\.org/i.test(groupText);
  const authorNames=region?.role==="plain text"&&(groupText.match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+/g)||[]).length>=3&&!/\b(?:the|of|is|are|was|were|this|that|using|show|Fig|Figure)\b/i.test(groupText);
  const pieces=segment({...content,items},{...viewport,zbpRegionRole:region?.confidence>=.6?region.role:null},pdfjs,pageNumber);
  // A short final line may miss the old width-overlap heuristic. The model
  // provides the shared paragraph boundary; join only an unfinished sentence.
  if(region?.role==="plain text")for(let i=1;i<pieces.length;){
   const a=pieces[i-1],b=pieces[i],tail=a.text.trim(),head=b.text.trim();
   // A terminal line may be labelled short/non-body solely because it has
   // one or two words. It still belongs to the same confident body box.
   const shortTail=region.confidence>=.8&&!publication&&!authorNames&&b.reason==="短标签或非正文"&&/^[a-z]/.test(head)&&(head.match(/[A-Za-z]+/g)||[]).length>=1;
   const same=a.selected&&(b.selected||shortTail)&&!a.protectedFormula&&!b.protectedFormula&&a.kind==="正文"&&b.kind==="正文"&&Math.abs(a.fs-b.fs)<a.fs*.15;
   if(same&&!/[.!?:;][)\]”'\s]*$/.test(tail)&&/^[a-z(]/.test(head)&&Math.abs(a.x-b.x)<Math.max(12,a.fs*1.6)&&b.y-a.y-a.h<a.fs*1.2&&b.y>=a.y){
    const math={};let serial=0;const remap=v=>v.text.replace(/⟦M\d+⟧/g,t=>{const k="⟦M"+(++serial)+"⟧";math[k]=v.math[t];return k;});
    const text=remap(a)+" "+remap(b),right=Math.max(a.x+a.w,b.x+b.w),bottom=Math.max(a.y+a.h,b.y+b.h);
    a.text=text;a.math=math;a.lines.push(...b.lines);a.x=Math.min(a.x,b.x);a.y=Math.min(a.y,b.y);a.w=right-a.x;a.h=bottom-a.y;pieces.splice(i,1);
   }else i++;
  }
  // A figure reference inside a model-owned body region is not a caption.
  // Require an unfinished, same-font body immediately above; model captions
  // remain captions. Keep physical pieces/IDs stable for existing manual edits.
  if(region?.role==="plain text"&&region.confidence>=.8)for(let i=1;i<pieces.length;i++){
   const a=pieces[i-1],b=pieces[i];
   if(a.kind==="正文"&&(a.selected||a.reason==="短标签或非正文"&&(a.text.match(/[A-Za-z]{2,}/g)||[]).length>=3)&&b.kind==="图表标题"&&!b.protectedFormula&&
      !/[.!?:;][)\]”'\s]*$/.test(a.text.trim())&&Math.abs(a.fs-b.fs)<a.fs*.12&&
      Math.abs(a.x-b.x)<a.fs*1.6&&b.y-a.y-a.h<a.fs*1.5){b.kind="正文";b.reason="";b.selected=true;b.inlineFigureReference=true;}
  }
  for(const b of pieces){
   b.modelRegion=region?{...region}:null;
   if(region){
    const role=region.role,plain=b.text.replace(/⟦M\d+⟧/g,t=>b.math[t]?.text||t);
    const metadata=publication||authorNames||containsEmail(plain)||/copyright|©|all rights reserved|^Licensee |^Citation:|^(?:Received|Revised|Accepted|Published):/i.test(plain)||/^(?:School|Department|Faculty|Institute|University|Laboratory|State Key Laboratory|Correspondence)(?=\s|,|:|$)/i.test(plain);
    let kind=b.kind,reason=b.reason;
    if(role==="isolate_formula"||role==="formula_caption"){reason="公式";b.protectedFormula=true;b.formulaZone={x:region.x,y:region.y,w:region.w,h:region.h};}
    else if(role==="table")reason="表格单元格";
    else if(role==="figure")reason="图内标签";
    else if(role==="abandon")reason="出版信息或页眉页脚";
    else if(!b.protectedFormula&&role==="title"){kind="标题";reason="";}
    else if(!b.protectedFormula&&captions.has(role)){kind="图表标题";reason="";}
    else if(metadata)reason="出版或联系信息";
    else if(role==="plain text"&&!b.protectedFormula&&reason==="短标签或非正文"&&(plain.match(/[A-Za-z]{2,}/g)||[]).length>=3){reason="";kind="正文";}
    b.baseClassification={selected:!reason,reason,kind};Object.assign(b,b.baseClassification);
   }
   blocks.push(b);
  }
 }
 blocks.sort((a,b)=>a.y-b.y||a.x-b.x);blocks.forEach((b,i)=>{b.id="p"+pageNumber+"b"+i;});
 protectTableNotes(blocks,regions);
 const wrapped=wrappedAbstract(assigned,regions,blocks,content,viewport,pdfjs,pageNumber,options);
 if(wrapped){
  const removed=new Set(wrapped.replaced);
  const retained=blocks.filter(b=>!removed.has(b));
  blocks.splice(0,blocks.length,...[...retained,wrapped.merged].sort((a,b)=>a.y-b.y||a.x-b.x));
 }
 const owned=blocks.flatMap(b=>b.lines.flatMap(l=>l.parts.map(p=>p.sourceIndex)));
 if(owned.length!==expected.length||new Set(owned).size!==expected.length||expected.some(i=>!owned.includes(i)))throw new Error("本机版面识别后原文归属不完整，已停止翻译。");
 return blocks;
}
export function modelObstacles(modelPage){return modelPage.regions.filter(r=>r.confidence>=.55&&["figure","table"].includes(r.role)&&r.w*r.h<modelPage.width*modelPage.height*.85).map(r=>({...r,kind:r.role}));}
