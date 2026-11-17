// Plan a whole column jointly inside verified spaces. No paragraph crosses a
// column, image, formula, retained text or fixed heading/caption boundary.
import {problem} from "./issues.mjs";
const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]||9;
const mergeIntervals=values=>{
  const out=[];for(const v of values.sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&v[0]<=last[1]+1)last[1]=Math.max(last[1],v[1]);else out.push([...v]);}return out;
};
export function safeSpans(page,flow,pixels,scale,movable){
  const start=flow.y,end=Math.min(page.height-24,flow.y+flow.h),hard=[];
  const members=new Set(movable.map(b=>b.id));
  for(const b of page.blocks)if(!members.has(b.id))for(const r of b.formulaZone?[b.formulaZone]:(b.lines?.length?b.lines:[b]))if(overlap(flow,r)>1)hard.push([r.y-2,r.y+r.h+2]);
  for(const r of page.visualRegions||[])if(overlap(flow,r)>1&&r.w*r.h<page.width*page.height*.85)hard.push([r.y-2,r.y+r.h+2]);
  const masks=movable.flatMap(b=>b.lines||[]).map(r=>({x:r.x-1.2,y:r.y-1.2,w:r.w+2.4,h:r.h+2.4}));
  if(pixels?.data){
    const x0=Math.max(0,Math.floor(flow.x*scale)),x1=Math.min(pixels.width-1,Math.ceil((flow.x+flow.w)*scale));
    let inkStart=null;
    for(let y=Math.max(0,Math.floor(start*scale));y<Math.min(pixels.height,Math.ceil(end*scale));y++){
      const active=masks.filter(r=>y/scale>=r.y&&y/scale<=r.y+r.h).map(r=>[Math.floor(r.x*scale),Math.ceil((r.x+r.w)*scale)]);
      const erased=x=>active.some(r=>x>=r[0]&&x<=r[1]);
      const samples=[];for(let x=x0;x<=x1;x+=Math.max(1,Math.floor((x1-x0)/32))){if(erased(x))continue;const i=(y*pixels.width+x)*4;samples.push((pixels.data[i]+pixels.data[i+1]+pixels.data[i+2])/3);}
      const bg=median(samples.length?samples:[255]);let dark=0,total=0;
      for(let x=x0;x<=x1;x+=2){if(erased(x))continue;const i=(y*pixels.width+x)*4;total++;if(Math.abs((pixels.data[i]+pixels.data[i+1]+pixels.data[i+2])/3-bg)>35&&++dark>=Math.max(3,(x1-x0)/scale*.015))break;}
      const ink=dark>=Math.max(3,(x1-x0)/scale*.015);
      if(ink&&inkStart===null)inkStart=y/scale;
      if(!ink&&inkStart!==null){hard.push([inkStart-2,y/scale+2]);inkStart=null;}
    }
    if(inkStart!==null)hard.push([inkStart-2,end]);
  }
  let cursor=start;const spans=[];
  for(const [a,b] of mergeIntervals(hard)){if(b<=start||a>=end)continue;if(a>cursor+4)spans.push({y:cursor,h:a-cursor});cursor=Math.max(cursor,b);}
  if(end>cursor+4)spans.push({y:cursor,h:end-cursor});return spans;
}
export function planColumns(page,translations,font,fit,pixels,scale){
  const planned=new Map(),issues=[],members=new Set();
  for(const flow of page.structure?.flows||[]){
    const blocks=flow.blocks.map(id=>page.blocks.find(b=>b.id===id)).filter(b=>b?.selected&&translations[b.id]&&b.role==="body");
    const shaped=blocks.filter(b=>!(page.visualRegions||[]).some(r=>r.w*r.h<page.width*page.height*.85&&overlap(b,r)>1&&b.y<r.y+r.h&&b.y+b.h>r.y));
    blocks.splice(0,blocks.length,...shaped);if(!blocks.length)continue;for(const b of blocks)members.add(b.id);
    const spans=safeSpans(page,flow,pixels,scale,blocks),groups=new Map();
    for(const b of blocks){
      const span=spans.filter(s=>s.y<b.y+b.h&&s.y+s.h>b.y).sort((a,z)=>Math.min(z.y+z.h,b.y+b.h)-Math.max(z.y,b.y)-(Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)))[0];
      if(!span){issues.push({...problem("layout_space","正文所在区域被图片、公式或保留文字占用，请检查结构区域。",[b.id]),geometry:{source:{x:b.x,y:b.y,w:b.w,h:b.h},flow,spans}});continue;}
      if(!groups.has(span))groups.set(span,[]);groups.get(span).push(b);
    }
    for(const [span,bs] of groups){
      bs.sort((a,b)=>a.y-b.y);const base=median(bs.map(b=>b.fs)),target=Math.min(12,Math.max(8,base*1.08)),min=5.5;let solution=null;
      for(let size=target;size>=min-.001&&!solution;size-=.25)for(const factor of [1.48,1.6,1.75,2,1.36,1.27,1.16,1.08]){
        const candidates=bs.map(b=>{
          const override={...b.layoutOverride,fontSize:b.layoutOverride?.fontSize||size,leading:b.layoutOverride?.leading||factor};
          const r=fit({...b,x:flow.x,w:flow.w,layoutH:span.h,layoutOverride:override},translations[b.id],font);
          if(!r||r.ink.some((v,i)=>i>0&&(i-1)*r.leading+r.ink[i-1].bottom>i*r.leading+v.top+.1))return null;const top=Math.min(0,...r.ink.map((v,i)=>i*r.leading+v.top)),bottom=Math.max(...r.ink.map((v,i)=>i*r.leading+v.bottom));return {...r,x:flow.x,w:flow.w,h:bottom-top,top};
        });
        const gap=Math.max(3,size*.45);
        if(candidates.some(v=>!v)||candidates.reduce((n,v)=>n+v.h,0)+gap*(bs.length-1)>span.h)continue;
        let cursor=span.y;const suffix=candidates.map((_,i)=>candidates.slice(i).reduce((n,v)=>n+v.h,0)+gap*(bs.length-i-1));
        solution=candidates.map((r,i)=>{const inkY=Math.max(cursor,Math.min(bs[i].y,span.y+span.h-suffix[i]));cursor=inkY+r.h+gap;return {...r,y:inkY-r.top};});break;
      }
      if(!solution){issues.push({...problem("layout_space","整栏可用空间不足，已共同调整字号和行距仍无法完整放入；可检查结构或局部预览。",bs.map(b=>b.id)),geometry:{flow,span,spans,sourceHeights:bs.map(b=>({id:b.id,h:b.h}))}});continue;}
      bs.forEach((b,i)=>planned.set(b.id,solution[i]));
    }
  }
  return {planned,issues,members};
}
