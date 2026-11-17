import {containsEmail} from "./source-text.mjs";
// Physical ownership, semantic roles and reading order are separate layers.
// Models may choose only from existing nodes/edges; coordinates never come from a model.
import {fingerprint,problem} from "./issues.mjs";
import {literal} from "./references.mjs";
export const STRUCTURE_VERSION="1.1.0";
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]||9;
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
const heading=b=>b.kind==="标题";
export function blockRole(b){
  if(b.protectedFormula||b.reason==="公式")return "formula";
  if(/^参考文献/.test(b.reason))return "references";
  if(/页眉|页脚/.test(b.reason))return "running";
  if(/表格/.test(b.reason))return "table";
  if(b.kind==="图表标题"||((b.lines||[]).length>1&&/^(?:Fig(?:ure)?\.?|Table)\s*S?\s*\d+[A-Za-z]?\s*$/i.test(b.lines[0].text?.trim()||"")))return "caption";
  if(/出版或联系信息|出版信息/.test(b.reason))return "metadata";
  if(/图内标签/.test(b.reason))return "label";
  if(containsEmail(b.text)||/copyright|©|all rights reserved|https?:\/\/|\bdoi\s*:|corresponding\s+author|^\*?\s*author\s+affiliation/i.test(b.text))return "metadata";
  if((b.lines||[]).length<3&&/^(?:⟦M\d+⟧\s*|[a-z]\s+|\*?\s*)*(?:School|Department|College|Faculty|Institute|Laboratory|State Key Laboratory|Centre|Center|University)(?=\s|,|:|$)/i.test(b.text))return "metadata";
  if(b.wrappedAbstract)return "abstract";
  if(heading(b))return "heading";
  return b.kind==="正文"&&!b.reason?"body":b.selected?"body":"label";
}
export const roleNames={keywords:"关键词",body:"正文",abstract:"摘要",heading:"标题",caption:"图注",formula:"公式",references:"参考文献",running:"页眉页脚",metadata:"出版或联系信息",label:"标签",image:"图片"};
const rect=b=>({x:b.x,y:b.y,w:b.w,h:b.h});
const aStamp=b=>fingerprint([b.text,b.page,rect(b)]);
export function edgeStamp(a,b){return fingerprint([aStamp(a),aStamp(b)]);}
export function decisionStore(cache){return cache.structureDecisions ||= {links:{},labels:{},requests:{}};}
export function extractVisualRegions(list,OPS,viewport){
  let matrix=[1,0,0,1,0,0],alpha=1,clip={x:0,y:0,right:viewport.width,bottom:viewport.height};const stack=[],regions=[];
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const imageOps=new Set([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintSolidColorImageMask].filter(Number.isFinite));
  for(let i=0;i<list.fnArray.length;i++){
    const fn=list.fnArray[i],args=list.argsArray[i];
    if(fn===OPS.save)stack.push({matrix:[...matrix],alpha,clip:{...clip}});
    else if(fn===OPS.restore){const s=stack.pop();if(s){matrix=s.matrix;alpha=s.alpha;clip=s.clip;}}
    else if(fn===OPS.paintFormXObjectBegin){
      stack.push({matrix:[...matrix],alpha,clip:{...clip}});if(args[0])matrix=multiply(matrix,args[0]);
      if(args[1]){const m=multiply(viewport.transform,matrix),r=args[1],points=[[r[0],r[1]],[r[2],r[1]],[r[0],r[3]],[r[2],r[3]]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);clip={x:Math.max(clip.x,Math.min(...points.map(p=>p[0]))),y:Math.max(clip.y,Math.min(...points.map(p=>p[1]))),right:Math.min(clip.right,Math.max(...points.map(p=>p[0]))),bottom:Math.min(clip.bottom,Math.max(...points.map(p=>p[1])))};}
    }
    else if(fn===OPS.paintFormXObjectEnd){const s=stack.pop();if(s){matrix=s.matrix;alpha=s.alpha;clip=s.clip;}}
    else if(fn===OPS.transform)matrix=multiply(matrix,args);
    else if(fn===OPS.setGState){for(const [key,value] of args[0]||[])if(key==="ca")alpha=value;}
    else if(imageOps.has(fn)&&alpha>.45){
      const m=multiply(viewport.transform,matrix),points=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
      const x=Math.max(clip.x,Math.min(...points.map(p=>p[0]))),y=Math.max(clip.y,Math.min(...points.map(p=>p[1])));
      const w=Math.min(clip.right,Math.max(...points.map(p=>p[0])))-x,h=Math.min(clip.bottom,Math.max(...points.map(p=>p[1])))-y;
      if(w>6&&h>6)regions.push({x,y,w,h,kind:"image"});
    }
  }
  return [...new Map(regions.map(r=>[JSON.stringify(r),r])).values()];
}
export function buildStructure(pages,decisions={links:{},labels:{}}){
  const graph={version:STRUCTURE_VERSION,edges:[],candidates:[],uncertainNodes:[],reviewNodes:[],issues:[]};
  const all=pages.flatMap(p=>p.blocks),byID=new Map(all.map(b=>[b.id,b]));
  for(const page of pages){
    const intro=page.blocks.filter(b=>/^(?:1[.\s]+)?Introduction\s*$/i.test(b.text));
    const introY=intro.length?Math.min(...intro.map(b=>b.y)):0;
    for(const b of page.blocks){
      b.role=blockRole(b);
      // Publisher keyword rows are independent lists, not continuation prose.
      // A shorter list can otherwise be mistaken for a second column and
      // connected after the introduction's unfinished page-end sentence.
      if(b.role==="body"&&(/^(?:key\s*words?|index terms)\s*[:：]/i.test(b.text)||page.blocks.some(label=>label!==b&&/^(?:key\s*words?|index terms)\s*[:：]\s*$/i.test(label.text.trim())&&Math.abs(label.y-b.y)<Math.max(label.fs,b.fs)*.35&&b.x>=label.x+label.w-1&&b.x-label.x-label.w<Math.max(18,b.fs*2))))b.role="keywords";
      // A leading wide paragraph is an independent abstract region, not a column bridge.
      const besideIntroduction=intro.some(h=>b.y<h.y+Math.max(20,b.fs*2)&&b.x+b.w<h.x+2);
      if(b.role==="body"&&introY&&(b.y+b.h<=introY+2||besideIntroduction)&&b.w>page.width*.43&&b.text.length>180)b.role="abstract";
      const d=decisions.labels?.[b.id];
      const roles=["body","caption","metadata","label"],manual=d?.origin==="manual";
      if(d?.stamp===aStamp(b)&&(manual?[...roles,"abstract","heading"]:roles).includes(d.role)&&(manual?!["formula","references","table","running"].includes(b.role):roles.includes(b.role))){
        b.role=d.role;b.selected=["body","abstract","heading","caption"].includes(d.role);b.reason=b.selected?"":"结构确认保留";
      }
    }
    for(const b of page.blocks){const o=decisions.selectionOverrides?.[b.id];if(o?.source===b.text&&!["formula","references","table"].includes(b.role))b.selected=o.selected;}
    const body=page.blocks.filter(b=>b.role==="body");
    const clusters=[];
    for(const b of [...body].sort((a,b)=>Math.min(3,(b.lines||[]).length)-Math.min(3,(a.lines||[]).length)||a.x-b.x||a.y-b.y)){
      let c=clusters.find(c=>(Math.min(c.w,b.w)/Math.max(c.w,b.w)>.68||(b.lines||[]).length<3&&b.w<=c.w)&&((b.lines||[]).length>1||b.w<=c.w+Math.max(12,c.w*.08))&&Math.abs(c.x-b.x)<Math.max(10,b.fs*1.6)&&(!c.multiLine||(b.lines||[]).length<3||Math.min(c.w,b.w)/Math.max(c.w,b.w)>.68));
      if(!c){c={x:b.x,w:b.w,blocks:[],multiLine:false};clusters.push(c);}c.blocks.push(b);c.multiLine ||= (b.lines||[]).length>=3;c.x=Math.min(c.x,b.x);c.w=Math.max(c.w,b.x+b.w-c.x);
    }
    // Overlapping narrow/wide sidebars belong to the same semantic column.
    const parent=clusters.map((_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
    for(let i=0;i<clusters.length;i++)for(let j=0;j<i;j++)if(clusters[i].w<page.width*.65&&clusters[j].w<page.width*.65&&overlap(clusters[i],clusters[j])>Math.min(clusters[i].w,clusters[j].w)*.5)parent[find(i)]=find(j);
    const roots=[...new Set(clusters.map((_,i)=>find(i)))].sort((a,b)=>Math.min(...clusters.filter((_,i)=>find(i)===a).map(c=>c.x))-Math.min(...clusters.filter((_,i)=>find(i)===b).map(c=>c.x)));
    const flows=[];
    for(const [i,c] of clusters.entries()){
      const minY=Math.min(...c.blocks.map(b=>b.y)),maxY=Math.max(...c.blocks.map(b=>b.y+b.h));let bottom=page.height-24;
      for(const other of clusters)if(other!==c&&overlap(c,other)>Math.min(c.w,other.w)*.5){const start=Math.min(...other.blocks.map(b=>b.y));if(start>=maxY-1&&start>minY)bottom=Math.min(bottom,start-1);}
      const column=roots.indexOf(find(i)),flow={id:"p"+page.number+"r"+i,x:c.x,y:minY,w:c.w,h:Math.max(0,bottom-minY),column,blocks:c.blocks.sort((a,b)=>a.y-b.y).map(b=>b.id)};
      flows.push(flow);for(const b of c.blocks){b.flowID=flow.id;b.column=column;}
    }
    for(const b of page.blocks){
      const matching=flows.filter(f=>overlap(f,b)>Math.min(f.w,b.w)*.5).sort((a,z)=>Math.abs(a.x-b.x)-Math.abs(z.x-b.x));
      const column=b.role==="abstract"?-1:b.column>=0&&b.role==="body"?b.column:matching[0]?.column??(b.w<page.width*.65?(b.x>=page.width*.48?Math.max(1,roots.length):0):-1);
      b.readingIndex=page.number*1000000+(column+1)*10000+b.y*5+b.x/page.width;
    }
    for(const b of page.blocks){const d=decisions.labels?.[b.id];if(d?.stamp===aStamp(b)&&!["formula","references","table","running"].includes(b.role))graph.reviewNodes.push({id:b.id,stamp:d.stamp,allowedRoles:["body","caption","metadata","label"],text:b.text,page:page.number,rect:rect(b),role:b.role,origin:d.origin});}
    const nodes=page.blocks.map(b=>({id:b.id,role:b.role,stamp:aStamp(b),rect:rect(b),flowID:b.flowID||null,readingIndex:b.readingIndex,evidence:b.role==="body"?"文字与栏位":"保留或独立区域"}));
    page.structure={version:STRUCTURE_VERSION,flows,nodes,images:page.visualRegions||[],issues:[]};
    // Short, multiword prose aligned with a body region may be a lost paragraph fragment.
    for(const b of page.blocks.filter(b=>b.role==="label"&&((/[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(b.text)&&b.text.length>25)||/^[a-z][A-Za-z-]{3,}[.!?;,]/.test(b.text)||(b.modelRegion?.role==="plain text"&&b.modelRegion.confidence>=.65&&/^[a-z][A-Za-z-]+(?:\s+[A-Za-z-]+)+[.!?]$/.test(b.text))))){
      if(decisions.labels?.[b.id]?.stamp===aStamp(b)||decisions.selectionOverrides?.[b.id]?.source===b.text&&decisions.selectionOverrides[b.id].selected===false)continue;
      if(!(page.visualRegions||[]).some(r=>b.x>=r.x&&b.x+b.w<=r.x+r.w&&b.y>=r.y&&b.y+b.h<=r.y+r.h)&&flows.some(f=>Math.abs(f.x-b.x)<Math.max(12,b.fs*2)&&b.y>=f.y-Math.max(b.modelRegion?.role==="plain text"?72:20,b.fs*2)&&b.y<f.y+f.h))graph.uncertainNodes.push({id:b.id,stamp:aStamp(b),allowedRoles:["body","caption","metadata","label"],text:b.text,page:page.number,rect:rect(b),before:page.blocks.filter(v=>v.role==="body"&&v.selected&&v.readingIndex<b.readingIndex).sort((a,z)=>z.readingIndex-a.readingIndex)[0]?.text.slice(-300)||pages.find(p=>p.number===page.number-1)?.blocks.filter(v=>v.role==="body"&&v.selected).sort((a,z)=>z.readingIndex-a.readingIndex)[0]?.text.slice(-300)||"",after:page.blocks.filter(v=>v.role==="body"&&v.selected&&v.y>b.y&&overlap(v,b)>0).sort((a,z)=>a.y-z.y)[0]?.text.slice(0,300)||""});
    }
  }
  const eligible=b=>b.role==="body"&&b.selected&&!containsEmail(b.text);
  const taggedFrom=new Set(),taggedTo=new Set();
  const consider=(a,b,kind)=>{
    const confirmed=kind==="tagged-paragraph";
    if(!a||!b||a.id===b.id||!eligible(a)||!eligible(b))return;
    if(graph.edges.some(e=>e.from===a.id&&e.to===b.id))return;
    const manual=decisions.links?.[a.id+"->"+b.id]?.origin==="manual";
    if(!confirmed&&!manual&&(taggedFrom.has(a.id)||taggedTo.has(b.id)))return;
    const tail=literal(a).replace(/\s*\[\d[\dA-Za-z,\s–—-]*\]\s*$/," ").trim(),head=literal(b).trim();
    const retainedBetween=all.some(v=>(v.role==="body"&&!v.selected||["references","heading"].includes(v.role))&&v.readingIndex>a.readingIndex&&v.readingIndex<b.readingIndex);
    const incompatible=retainedBetween||Math.abs(a.fs-b.fs)>Math.max(.6,a.fs*.25);
    const closed=/[.!?。！？:;][)\]”'\s]*$/.test(tail)&&!/\b(?:et al|e\.g|i\.e|Fig|Eq)\.$/.test(tail);
    const newHeading=pages.find(p=>p.number===b.page).blocks.some(h=>h.role==="heading"&&h.y<=b.y&&b.y-h.y-h.h<Math.max(18,b.fs*2)&&overlap(h,b)>0);
    const indent=(b.lines?.[0]?.x??b.x)-b.x>b.fs*.8;
    const gap=b.page===a.page?b.y-a.y-a.h:0;
    let decision="separate",evidence="完整句或区域边界";
    if(confirmed&&!closed&&!incompatible&&!newHeading&&!indent&&(a.page!==b.page||a.column!==b.column||gap<a.fs*2)){
      decision="join";evidence="PDF 标签与段落边界一致";
    }
    else if(!confirmed&&!closed&&!incompatible&&!newHeading){
      if(b.inlineFigureReference&&a.modelRegion?.id===b.modelRegion?.id&&kind==="within-flow"){decision="join";evidence="同一正文区域中的句内图号";}
      else if(/[-\u00ad]$/.test(tail)&&/^[a-z]/.test(head)){decision="join";evidence="断词续接";}
      else if(/^[a-z(]/.test(head)&&!indent&&(kind!=="within-flow"||gap<a.fs*2)){decision="join";evidence="未完句与同栏/分页续接";}
      else{decision="uncertain";evidence="需要语义确认";}
    }
    const id=a.id+"->"+b.id,stamp=edgeStamp(a,b),stored=decisions.links?.[id];
    if(stored?.stamp===stamp&&(!confirmed||manual||!stored.join||decision==="join")){decision=stored.join?"join":"separate";evidence=stored.origin==="manual"?"人工确认":"模型语义确认";}
    const edge={id,from:a.id,to:b.id,kind,decision,evidence,stamp};graph.edges.push(edge);
    if(decision==="uncertain")graph.candidates.push(edge);
    if(confirmed&&decision==="join"){taggedFrom.add(a.id);taggedTo.add(b.id);}
  };
  const taggedParagraphs=new Map();
  for(const b of all){
    if(!b.sourceParagraph?.ref||b.role!=="body")continue;
    const ref=b.sourceParagraph.ref;
    if(!taggedParagraphs.has(ref))taggedParagraphs.set(ref,[]);
    taggedParagraphs.get(ref).push(b);
  }
  for(const blocks of taggedParagraphs.values()){
    blocks.sort((a,b)=>a.page-b.page||a.sourceParagraph.order-b.sourceParagraph.order||a.readingIndex-b.readingIndex);
    for(let i=1;i<blocks.length;i++){
      const a=blocks[i-1],b=blocks[i];
      if(a.readingIndex<b.readingIndex&&Math.abs(a.fs-b.fs)<=Math.max(.6,a.fs*.25))consider(a,b,"tagged-paragraph");
    }
  }
  for(const page of pages){
    const values=page.blocks.filter(eligible),columns=[...new Set(values.map(b=>b.column))].sort((a,b)=>a-b);
    for(const column of columns){const col=values.filter(b=>b.column===column).sort((a,b)=>a.y-b.y);
      for(let i=1;i<col.length;i++)consider(col[i-1],col[i],"within-flow");
    }
    for(let i=1;i<columns.length;i++){
      const left=values.filter(b=>b.column===columns[i-1]).sort((a,b)=>a.y-b.y),right=values.filter(b=>b.column===columns[i]).sort((a,b)=>a.y-b.y);
      const a=left.at(-1),b=right[0];if(a&&b)consider(a,b,"column-break");
    }
    const next=pages.find(p=>p.number>page.number&&p.blocks.some(eligible));
    if(next){const a=values.sort((a,b)=>a.column-b.column||a.y-b.y).at(-1),bs=next.blocks.filter(eligible).sort((a,b)=>a.column-b.column||a.y-b.y),b=bs[0];if(a&&b)consider(a,b,"page-break");}
  }
  // Captions are independent of body column flows, but a single model caption
  // can contain multiple physical pieces (indent, short line, inline scripts).
  // Join only adjacent pieces inside the same confident caption region; never
  // grow the box or merge a second numbered caption, body, figure or table.
  const captionStart=b=>/^(?:Fig(?:ure)?\.?|Table|Scheme)\s*S?\s*\d+[A-Za-z]?\b/i.test(literal(b).trim());
  for(const page of pages){
    const regions=new Map();
    for(const b of page.blocks.filter(b=>b.role==="caption"&&b.selected&&b.modelRegion?.confidence>=.65&&["figure_caption","table_caption"].includes(b.modelRegion.role))){
      const key=b.modelRegion.id;if(!key)continue;
      if(!regions.has(key))regions.set(key,[]);regions.get(key).push(b);
    }
    for(const pieces of regions.values()){
      pieces.sort((a,b)=>a.y-b.y||a.x-b.x);
      for(let i=1;i<pieces.length;i++){
        const a=pieces[i-1],b=pieces[i],gap=b.y-a.y-a.h;
        if(captionStart(b)||b.y<a.y+a.h-Math.min(a.h,b.h)*.3||gap>Math.max(a.fs,b.fs)*1.8||Math.abs(a.fs-b.fs)>Math.max(a.fs,b.fs)*.25||overlap(a,b)<Math.min(a.w,b.w)*.65)continue;
        const between=page.blocks.some(v=>v!==a&&v!==b&&v.y>=a.y+a.h-1&&v.y+v.h<=b.y+1&&overlap(v,a)>0);
        if(between)continue;
        const id=a.id+"->"+b.id,stamp=edgeStamp(a,b),stored=decisions.links?.[id];
        const joined=stored?.stamp===stamp?stored.join:true;
        graph.edges.push({id,from:a.id,to:b.id,kind:"caption-continuation",decision:joined?"join":"separate",evidence:stored?.stamp===stamp?"已确认的图注连接":"同一图注区域内的相邻续行",stamp});
        // Keep a full-width caption ordered top to bottom even if its short
        // tail was geometrically assigned to a body column.
        if(joined)b.readingIndex=a.readingIndex+(b.y-a.y)*5+.001;
      }
    }
  }
  const parents=new Map(),find=id=>parents.has(id)?find(parents.get(id)):id;
  for(const e of graph.edges.filter(e=>e.decision==="join")){const a=find(e.from),b=find(e.to);if(a!==b)parents.set(b,a);}
  const groups=new Map();for(const b of all){b.paragraphID=find(b.id);if(!groups.has(b.paragraphID))groups.set(b.paragraphID,[]);groups.get(b.paragraphID).push(b);}
  for(const members of groups.values())if(members.length>1){
    members.sort((a,b)=>a.readingIndex-b.readingIndex);const fragments=members.map(b=>({id:b.id,page:b.page,text:b.text.replace(/⟦M\d+⟧/g,t=>b.math[t]?.text||t)}));
    const context={id:members[0].paragraphID,fullText:fragments.map(f=>f.text).join(" ").replace(/- ([a-z])/g,"-$1"),fragments};for(const b of members){b.paragraphContext=context;b.paragraphSource=context.fullText;}
  }
  for(const e of graph.candidates)graph.issues.push(problem("source_structure","段落连接尚未确认；可用结构检查确认，或生成时由模型辅助判断。",[e.from,e.to]));
  for(const n of graph.uncertainNodes)graph.issues.push(problem("source_structure","该文字区域可能是遗漏正文；请在结构检查确认类别。",[n.id]));
  const owned=all.flatMap(b=>(b.lines||[]).flatMap(l=>(l.parts||[]).filter(p=>Number.isInteger(p.sourceIndex)).map(p=>[b.page,p.sourceIndex].join(":"))));
  if(owned.length!==new Set(owned).size)throw new Error("页面结构存在重复原文归属，已停止翻译。");
  graph.byID=Object.fromEntries(all.map(b=>[b.id,{page:b.page,text:b.text,role:b.role}]));return graph;
}
