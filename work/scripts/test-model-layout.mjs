import {auditSource} from "../addon/content/quality.mjs";
import assert from "node:assert/strict";
import {buildStructure} from "../addon/content/structure.mjs";
import {layoutObstacles,segmentWithModel} from "../addon/content/model-layout.mjs";
const vp={width:600,height:800,transform:[]},pdfjs={Util:{transform:(_a,b)=>b}},styles={body:{ascent:.8,descent:-.2,fontFamily:"serif"}},tests=[];
const text=(str,x,y,w=220,fs=10)=>({str,fontName:"body",width:w,height:fs,transform:[fs,0,0,fs,x,y]});
const region=(id,role,x,y,w,h)=>({id,role,x,y,w,h,confidence:.95});
const group=(items,regions)=>segmentWithModel({items,styles},vp,pdfjs,1,{width:600,height:800,regions});
const check=(name,fn)=>{fn();tests.push(name);};
check("近邻版权单词不能成为正文上下标",()=>{const b=group([text("A scientific paragraph describes the behavior of photodetectors.",170,300,380),text("Switzerland.",50,300,100,7)],[region("body","plain text",165,285,395,30),region("copyright","plain text",40,280,115,45)]);assert.equal(b.length,2);assert(!b.find(v=>v.modelRegion.id==="body").text.includes("Switzerland"));assert.equal(new Set(b.flatMap(v=>v.lines.flatMap(l=>l.parts.map(p=>p.sourceIndex)))).size,2);});
check("整片版权说明分类传给续行",()=>{const b=group([text("Copyright: authors",40,300,100,7),text("This article is an open access article",40,310,110,7)],[region("copyright","plain text",35,285,120,45)]);assert(b.every(v=>!v.selected));});
check("未识别文字仍有物理归属",()=>{const b=group([text("Scientific source material with no model box.",40,300)],[]);assert.equal(b[0].lines[0].parts[0].sourceIndex,0);});
check("独立公式保持源区域保护",()=>{const b=group([text("y = A exp(t)",40,300)],[region("eq","isolate_formula",35,285,240,30)]);assert(b.every(v=>v.protectedFormula&&!v.selected));});
check("标题不因多个大写词误为作者",()=>{const b=group([text("Ultrathin Violet Phosphorus Nanosheets Exfoliation Characterization",40,200,500,18)],[region("title","title",30,175,530,50)]);assert(b.every(v=>v.selected&&v.kind==="标题"));});
check("模型与PDF页面尺寸不匹配时停止",()=>assert.throws(()=>segmentWithModel({items:[],styles},vp,pdfjs,1,{width:300,height:800,regions:[]})));
check("同区域短末行接回未完句",()=>{const b=group([text("This is a scientific paragraph that provided",40,300,270),text("the outstanding performance of our detector.",40,313,170)],[region("paragraph","plain text",35,285,290,45)]);assert.equal(b.length,1);assert(b[0].text.includes("provided the outstanding"));});
check("宽摘要短尾段不能扩大下方窄栏",()=>{
 const make=(id,y,w,count)=>({id,page:1,x:50,y,w,h:count*12,fs:10,text:"This scientific paragraph describes material properties and photoresponse.",kind:"正文",reason:"",selected:true,lines:Array.from({length:count},()=>({x:50,y,w,h:10,parts:[]}))});
 const shortWide=make("wide",450,500,2),column=make("column",525,240,15),page={number:1,width:600,height:800,blocks:[shortWide,column],visualRegions:[]};buildStructure([page]);assert.equal(page.structure.flows.find(f=>f.blocks.includes("column")).w,240);
});
check("句内图号仍属于同一正文区域",()=>{
 const b=group([text("The mechanism has been illustrated in",40,300,220),text("Fig. 16. They used nanorod arrays.",40,313,220)],[region("body","plain text",35,285,240,50)]);
 assert.equal(b.length,2);assert.equal(b[1].kind,"正文");assert(b[1].inlineFigureReference);
 const pages=[{number:1,width:600,height:800,blocks:b,visualRegions:[]}];const graph=buildStructure(pages);assert(graph.edges.some(e=>e.from===b[0].id&&e.to===b[1].id&&e.decision==="join"));
});
check("模型确认的真实图注保留图注角色",()=>{const b=group([text("Fig. 16. This diagram shows detector operation.",40,300)],[region("caption","figure_caption",35,285,250,35)]);assert.equal(b[0].kind,"图表标题");assert(!b[0].inlineFigureReference);});
check("模型遗漏图注行首时补齐相邻源项",()=>{
 const b=group([text("Fig. 3. Schematic illustrations of",40,300,150),text("two electrode systems and detector configurations.",191,300,300)],[region("caption","figure_caption",190,285,320,30)]);
 assert.equal(new Set(b.map(x=>x.modelRegion?.id)).size,1);assert(b.every(x=>x.modelRegion?.id==="caption"));assert(b.some(x=>x.text.startsWith("Fig.")));
});
check("图注补齐不能跨越栏缝或抢走正文区域",()=>{
 const b=group([text("This scientific body describes a material.",40,300,200),text("Fig. 3. Detector configuration.",300,300,220)],[region("body","plain text",35,285,210,30),region("caption","figure_caption",295,285,240,30)]);
 assert.equal(b.find(x=>x.text.startsWith("This")).modelRegion.id,"body");
});
check("laboratory-scale不是机构元数据",()=>{const b=group([text("laboratory-scale performance validation and parameter optimization.",40,300,220)],[region("body","plain text",35,285,240,30)]);const page={number:1,width:600,height:800,blocks:b,visualRegions:[]};buildStructure([page]);assert(b.every(x=>x.selected&&x.role==="body"));});
check("两词换栏尾句交给结构确认而不静默跳过",()=>{
 const b=group([text("performance indicators.",320,400,90),text("This body paragraph describes scientific measurements.",320,450,220)],[region("tail","plain text",315,385,110,30),region("body","plain text",315,435,240,35)]);
 const page={number:1,width:600,height:800,blocks:b,visualRegions:[]};const graph=buildStructure([page]);assert(graph.uncertainNodes.some(n=>n.text==="performance indicators."));
});
check("同一高置信正文框的两词尾行不会漏译",()=>{
 const b=group([text("This detector has promise for integration into advanced communication systems in",40,300,280),text("the future.",40,314.5,42)],[region("body","plain text",35,285,300,45)]);
 assert.equal(b.length,1);assert(b[0].selected);assert.match(b[0].text,/in the future\.$/);assert.equal(b[0].lines.length,2);
});
check("完整句后独立短标签不会被接回正文",()=>{
 const b=group([text("This paragraph describes the detector performance.",40,300,280),text("test label",40,314.5,42)],[region("body","plain text",35,285,300,45)]);
 assert.equal(b.length,2);assert(!b[1].selected);
});
check("异框短标签不并入正文",()=>{
 const b=group([text("This detector has promise for integration into advanced communication systems in",40,300,280),text("the future.",40,314.5,42)],[region("body","plain text",35,285,300,20),region("label","figure",35,307,70,15)]);
 assert.equal(b.length,2);assert.equal(b[1].reason,"图内标签");
});
check("关键词行独立于引言和正文续段",()=>{
 const make=(id,text,x,y,w,selected)=>({id,page:1,text,x,y,w,h:10,fs:10,selected,kind:"正文",reason:selected?"":"短标签或非正文",math:{},lines:[]});
 const label=make("label","Keywords:",170,300,45,false),keywords=make("keywords","solar blind; semiconductor; optical communication",218,300,240,true),body=make("body","The silicon detectors are relatively mature,",170,500,395,true);
 const graph=buildStructure([{number:1,width:600,height:800,blocks:[label,keywords,body],visualRegions:[]}]);assert.equal(keywords.role,"keywords");assert.equal(keywords.paragraphID,keywords.id);assert(!graph.edges.some(e=>e.to===keywords.id||e.from===keywords.id));assert(keywords.selected);
});

const wrappedRegions=[
 region("narrow","plain text",39,290,223,54),
 region("illustration","figure",273,290,280,53),
 region("wide","plain text",40,345,512,31),
];
const wrappedItems=[
 text("ABSTRACT: A scientific study reports",40,300),
 text("the measured signal from a new detector",40,312),
 text("using the candidate material for sensing",40,324),
 text("and evaluates its performance under",40,336),
 text("continuous illumination. The resulting device responds rapidly at low power.",40,352,508),
 text("These findings establish a basis for further study.",40,364,300),
];
check("绕图窄段和宽段由同一物理块覆盖",()=>{
 const blocks=group(wrappedItems,wrappedRegions);
 assert.equal(blocks.length,1);
 assert.equal(blocks[0].wrappedAbstract.sourceCount,6);
 assert.equal(blocks[0].lines.length,6);
 assert(blocks[0].text.includes("under continuous"));
 const [background,figure]=[{x:20,y:280,w:560,h:105,kind:"image"},{...wrappedRegions[1],kind:"image"}];
 const strip={x:20,y:272,w:560,h:13,kind:"image"},independent={x:30,y:270,w:90,h:10,kind:"image"};
 assert.deepEqual(layoutObstacles([background,strip,figure,independent],blocks),[figure,independent]);
});
check("不同段落及人工保留不能被绕图恢复覆盖",()=>{
 const items=wrappedItems.map((item,i)=>i===3?{...item,str:"and evaluates its performance."}:item);
 assert(!group(items,wrappedRegions).some(b=>b.wrappedAbstract));
 assert(!segmentWithModel({items:wrappedItems,styles},vp,pdfjs,1,{width:600,height:800,regions:wrappedRegions},{preserve:()=>true}).some(b=>b.wrappedAbstract));
});
check("表格脚注及其续行不进入正文流",()=>{
 const items=[text("Note: Values indicate results of the test under",40,411,500),text("continuous illumination.",40,423,150),text("continuous testing revealed significant performance differences.",305,450,240)];
 const regions=[region("table","table",38,300,510,101),region("note","table_footnote",38,402,510,25),region("body","plain text",300,438,253,30)];
 const blocks=group(items,regions);
 const notes=blocks.filter(b=>b.modelRegion?.id==="note");
 assert(notes.length&&notes.every(b=>b.reason==="表格注释"&&!b.selected));
});
const taggedBody=(id,page,text,y=170)=>({id,page,x:40,y,w:220,h:60,fs:10,text,kind:"正文",reason:"",selected:true,sourceParagraph:{ref:"15R",order:y},lines:[]});
check("同一原生段落可跨浮动页，保留人工拆分",()=>{
 const a=taggedBody("a",1,"This device delivers"),b=taggedBody("b",3,"a stable response.");
 const pages=[{number:1,width:600,height:800,blocks:[a]},{number:2,width:600,height:800,blocks:[]},{number:3,width:600,height:800,blocks:[b]}];
 const edge=buildStructure(pages).edges.find(e=>e.kind==="tagged-paragraph");
 assert.equal(edge.decision,"join");
 assert.equal(buildStructure(pages,{links:{[edge.id]:{stamp:edge.stamp,join:false,origin:"manual"}}}).edges.find(e=>e.id===edge.id).decision,"separate");
});
check("宽泛的 PDF 段落标签不会吞掉完整段落或远处正文",()=>{
 const a=taggedBody("a",1,"The device operated reliably. [12]");
 const b=taggedBody("b",1,"The next device exhibited",245);
 const c=taggedBody("c",1,"stable performance.",400);
 const d=taggedBody("d",1,"another independent passage",474);
 const pages=[{number:1,width:600,height:800,blocks:[a,b,c,d]}];
 const graph=buildStructure(pages);
 assert(graph.edges.filter(e=>e.kind==="tagged-paragraph").length>=2);
 assert.equal(new Set([a,b,c,d].map(b=>b.paragraphID)).size,4);
});

check("较大希腊字母与同基线的正文和图注保持连续",()=>{
 const items=[text("Fig. 1. Response of",40,300,90,8),text("α",133,300,6,9.6),text("-Fe",139,300,12,8),text("2",151,301.4,3,6),text("O",155,300,5,8),text("3",160,301.4,3,6),text("in the experiment.",167,300,75,8)];
 const blocks=group(items,[region("caption","figure_caption",38,289,210,25)]);
 assert.equal(blocks.length,1);
 assert.equal(blocks[0].lines.length,1);
 assert.equal(blocks[0].lines[0].parts.length,items.length);
 assert(blocks[0].text.includes("in the experiment"));
 assert(Object.values(blocks[0].math).some(p=>p.text==="α"));
});
check("送译前检查抓住源项齐全但正文断为两块",()=>{
 const r=region("text","plain text",40,290,240,30);
 const block=(id,x,w,index,modelRegion=r)=>({id,modelRegion,selected:true,role:"body",lines:[{x,w,fs:8,baseline:300,parts:[{sourceIndex:index,text:"body words"}]}]});
 const a=block("a",40,70,0),b=block("b",113,60,1);
 const p={number:1,sourceIndices:[0,1],blocks:[a,b]};
 assert.deepEqual(auditSource([p]).map(i=>i.blockIDs),[["a","b"]]);
 assert.deepEqual(auditSource([{...p,blocks:[a,block("b",240,60,1)]}]),[]);
 assert.deepEqual(auditSource([{...p,blocks:[a,block("b",113,60,1,{...r,id:"separate"})]}]),[]);
});
console.log(JSON.stringify({passed:tests.length,tests}));
