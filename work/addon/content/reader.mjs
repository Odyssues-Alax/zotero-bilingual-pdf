import {resolveDraft} from "./drafts.mjs";
import {issueGuidance,completionMessage,validationMessage,previewFailureMessage} from "./reader-feedback.mjs";
import {guardSourceBlocks,fontSymbolHints,visibleSymbols,symbolSummary,SYMBOL_REVISION,auditScientificDocument} from "./symbols.mjs";
import * as pdfjs from "./vendor/pdf.mjs";
import * as worker from "./vendor/pdf.worker.mjs";
import {ENGINE_VERSION,segment,hash,batches,translate,validateParagraph,scientificLabel,makePDF,message,aborted} from "./core.mjs";
import {MODEL_LAYOUT_VERSION,segmentWithModel,modelObstacles,layoutObstacles} from "./model-layout.mjs";
import {finalizeDocument,migrateCache,translationCurrent,locked,LAYOUT_REVISION} from "./document.mjs";
import {translateLogical,logicalJobs,splitLogical} from "./flow.mjs";
import {RECOVERY_VERSION,MAX_ATTEMPTS,recovery,canAttempt,reserveAttempt,resetAttempts,classify,problem,issuesError,groupedIssues,sourcePreflight,layoutStamp,titles,fingerprint,uniqueIssues,jobStamp} from "./issues.mjs";
import {fontPreflight,extractFont} from "./fonts.mjs";
import {extractVisualRegions,decisionStore,roleNames} from "./structure.mjs";
import {readSourceTags,applySourceTags} from "./pdf-structure.mjs";
import {assistStructure} from "./assist.mjs";
import {recoverDrafts,repairStamp} from "./repair.mjs";
import {auditSource,qualitySummary} from "./quality.mjs";
globalThis.pdfjsWorker=worker;
pdfjs.GlobalWorkerOptions.workerSrc="chrome://zbp/content/vendor/pdf.worker.mjs";
const $=id=>document.getElementById(id);
const args=window.arguments?.[0];
const bridge=args?.bridge, item=args?.item;
const state={pages:[],pdf:null,zh:null,source:null,cache:null,paths:null,scale:1,rows:[],busy:false,controller:null,renderChain:Promise.resolve(),searchHits:[],searchIndex:-1,issue:"",focusBlock:null,savedOutputAvailable:false,readingPreview:null};
let zoomTimer=null,zoomFrame=0,zoomPending=null;
window.ZBPApp={state,ready:null,generate,showRegions,showIssues,showStructure,showQuality,retryIssues,repairIssues,previewParagraph,search,goPage};
const status=(text,error=false)=>{$("status").textContent=text;$("status").classList.toggle("error",error);};
const fail=e=>{if(e?.issues){status(issueSummary(),true);renderIssueBadge();}else status(message(e),true);};
async function openPDF(bytes,inspectFonts=false) {
  return await pdfjs.getDocument({data:new Uint8Array(bytes),cMapUrl:"chrome://zbp/content/vendor/cmaps/",cMapPacked:true,
    standardFontDataUrl:"chrome://zbp/content/vendor/standard_fonts/",useSystemFonts:false,isEvalSupported:false,fontExtraProperties:inspectFonts}).promise;
}
async function initialize() {
  state.native=bridge?.getSettings().engine==="native";
  state.hybrid=!state.native&&bridge?.getSettings().engine!=="legacy";
  state.outputEngine=state.native?bridge.engine.version:state.hybrid?MODEL_LAYOUT_VERSION:ENGINE_VERSION;
  if(!bridge)throw new Error("请从 Zotero 菜单打开本窗口。");
  bind();
  if(args.settings)await showSettings();
  if(!item){status("先保存翻译设置，然后从文献或 PDF 附件的右键菜单打开对照阅读。");return;}
  $("native").disabled=false;
  state.source=await bridge.source(item);
  if(state.source.bytes.length>200*1024*1024)throw new Error("这份 PDF 超过 200 MB，请先压缩或拆分后再试。");
  state.source.hash=await hash(state.source.bytes);
  state.pdf=await openPDF(state.source.bytes,true);
  $("empty").hidden=true;
  $("document-title").textContent=state.source.title;
  document.title=state.source.title+" · 双语 PDF";
  $("page-count").textContent="/ "+state.pdf.numPages;
  $("page-number").max=state.pdf.numPages;
  $("region-page").max=state.pdf.numPages;
  $("region-page-count").textContent="/ "+state.pdf.numPages;
  state.paths=await bridge.paths(state.source.key);
  state.index=await bridge.json(state.paths.index);
  const settings=bridge.getSettings();
  await loadCache(settings);
  if(state.index?.sourceHash===state.source.hash && state.index.outputPath && state.index.engine===(state.outputEngine)) {
    try {
      const bytes=await IOUtils.read(state.index.outputPath);
      state.zh=await openPDF(bytes);
      if(state.zh.numPages!==state.pdf.numPages){await state.zh.destroy();state.zh=null;}
      else {state.savedOutputAvailable=true;$("open-folder").disabled=false;$("generate").textContent="重新生成";}
    }catch(_){status("之前的译版已移动或无法读取，可以重新生成。");}
  }
  if(state.native){
    for(let n=1;n<=state.pdf.numPages;n++){const p=await state.pdf.getPage(n),v=p.getViewport({scale:1});state.pages.push({number:n,width:v.width,height:v.height,blocks:[]});}
    if(state.index?.engine===bridge.engine.version&&state.index.regionsPath)state.nativeRegions=await bridge.json(state.index.regionsPath)||[];
    const issuePath=PathUtils.join(state.paths.dir,state.source.key+"-native-issues.json");
    const lastIssue=await bridge.json(issuePath);
    if(lastIssue?.sourceHash===state.source.hash&&lastIssue.error&&lastIssue.regionsPath){state.nativeError=lastIssue.error;state.nativeRegionsPath=lastIssue.regionsPath;state.nativeCachePath=lastIssue.cachePath;state.nativeRegions=await bridge.json(lastIssue.regionsPath)||state.nativeRegions;}
    nativeControls();await buildRows();status(state.nativeError|| (state.zh?"已载入本机引擎生成的中文译版。":"使用本机引擎识别原始 PDF；点击生成开始。首次使用请在设置中安装引擎。"),!!state.nativeError);
    window.dispatchEvent(new CustomEvent("zbp-ready"));return;
  }
  if(state.hybrid){
    state.layoutController=new AbortController();
    window.addEventListener("unload",()=>state.layoutController.abort(),{once:true});
    const layout=await bridge.engine.layout(bridge,state.source,state.paths,{signal:state.layoutController.signal,onProgress:e=>status(e.message||"识别页面区域…")});
    if(layout.sourceHash!==state.source.hash||layout.pages.length!==state.pdf.numPages)throw new Error("模型识别结果与原文不一致。");
    state.modelLayout=layout;
  }
  for(let n=1;n<=state.pdf.numPages;n++) {
    status("识别段落 "+n+" / "+state.pdf.numPages);
    const page=await state.pdf.getPage(n),viewport=page.getViewport({scale:1});
    const text=await page.getTextContent();
    const operators=await page.getOperatorList(),symbolHints=fontSymbolHints(page,operators,pdfjs.OPS,window.fontkit);
    for (const [id,style] of Object.entries(text.styles)) {
      try {const f=page.commonObjs.get(id);if(f?.name)style.fontFamily=f.name;}catch(_){}
    }
    const modelPage=state.modelLayout?.pages[n-1];
    const preserve=b=>[
      state.cache.selectionOverrides?.[b.id]?.origin==="manual"&&state.cache.selectionOverrides[b.id],
      state.cache.structureDecisions?.labels?.[b.id]?.origin==="manual"&&state.cache.structureDecisions.labels[b.id],
      state.cache.translations?.[b.id]?.manual&&state.cache.translations[b.id],
      state.cache.layoutOverrides?.[b.id]
    ].some(v=>v&&(v.source===b.text||v.stamp));
    const blocks=state.hybrid?segmentWithModel(text,viewport,pdfjs,n,modelPage,{preserve}):segment(text,viewport,pdfjs,n);
    const tags=await readSourceTags(page,text).catch(()=>null);
    applySourceTags(blocks,tags);
    const visualRegions=layoutObstacles([...extractVisualRegions(operators,pdfjs.OPS,viewport),...(state.hybrid?modelObstacles(modelPage):[])],blocks);
    const sourceIndices=text.items.flatMap((v,i)=>{if(!v.str?.trim())return [];const t=pdfjs.Util.transform(viewport.transform,v.transform);return Math.abs(t[1])<=Math.abs(t[0])*.15?[i]:[];});
    guardSourceBlocks(blocks,symbolHints,state.cache.symbolOverrides,n);
    state.pages.push({number:n,width:viewport.width,height:viewport.height,blocks,visualRegions,sourceIndices,symbolHints,visibility:text.zbpVisibility||{checked:0,clipped:0}});
    await new Promise(r=>setTimeout(r,0));
  }
  finalizeDocument(state.pages,{...decisionStore(state.cache),selectionOverrides:state.cache.selectionOverrides});
  state.structure=state.pages.structure;
  const migrated=reconcileCache();rebuildStructure();
  if(migrated)await persistCache();
  if(state.index?.sourceHash===state.source.hash && (state.index.engine!==state.outputEngine||state.index.layoutRevision!==LAYOUT_REVISION||state.index.symbolRevision!==SYMBOL_REVISION))
    state.issue="正文识别已更新。请重新生成中文 PDF；未变化段落会复用缓存。";
  const total=state.pages.reduce((n,p)=>n+p.blocks.filter(b=>b.selected).length,0);
  $("regions").disabled=false;$("structure").disabled=false;$("generate").disabled=total===0;
  const pendingDraft=firstDraft();
  if(pendingDraft&&!recovery(state.cache).issues.length)state.issue="段落 "+pendingDraft.id+" 的译文仍需处理。打开“检查段落”可修改草稿，或取消勾选保留原文。";
  renderIssueBadge();
  await buildRows();drawRegionOverlay();
  status(total ? (state.issue || (recovery(state.cache).issues.length?issueSummary():state.zh?(state.index?.completion==="partial"?"已载入待完成译版：部分段落按你的选择保留原文。":"已载入保存的中文译版。"):selected().every(b=>translationCurrent(b,state.cache.translations[b.id]))?"已恢复全部 "+total+" 段译文，点击生成即可排版保存，无需重新翻译。":"已识别 "+total+" 个区域，点击生成会复用已有译文。")) :
    "未识别到可翻译正文。这可能是扫描件；也可以打开“检查段落”手动勾选可选文字。",!total||!!state.issue||!!currentIssues().length);
  window.dispatchEvent(new CustomEvent("zbp-ready"));
}
function bind() {
  bindPan();
  $("auto-repair").onclick=()=>repairIssues().catch(fail);
  $("read-completed").onclick=async()=>{try{if(!state.readingPreview)await showReadingPreview();if(state.readingPreview){$("issues-dialog").close();status(issueSummary(),true);}}catch(e){fail(e);}};
  for(const id of ["regions-dialog","structure-dialog","preview-dialog"])$(id).addEventListener("close",()=>{
    if(state.issueReturn?.dialog!==id)return;
    const scroll=state.issueReturn.scroll;state.issueReturn=null;$("close-regions").textContent="完成";$("close-structure").textContent="关闭";$("close-preview").textContent="关闭";showIssues();$("issues-list").scrollTop=scroll;
  });
  $("quality").onclick=()=>showQuality();
  $("close-quality").onclick=()=>$("quality-dialog").close();
  $("structure").onclick=()=>showStructure();
  $("close-structure").onclick=()=>$("structure-dialog").close();
  $("reanalyze-structure").onclick=async()=>{if(state.busy)return;decisionStore(state.cache).requests={};recovery(state.cache).service=null;await persistCache();$("structure-dialog").close();generate().catch(fail);};
  $("edit-layout").onclick=()=>showIssues();
  $("skip-layout").onclick=()=>keepIssueOriginal().catch(fail);
  $("close-preview").onclick=()=>{state.previewClose?.();$("preview-dialog").close();};
  $("supplement-font").onclick=()=>chooseSupplementFont().catch(fail);
  $("issues").onclick=()=>showIssues();
  $("close-issues").onclick=()=>$("issues-dialog").close();
  $("retry-issues").onclick=()=>retryIssues().catch(fail);
  $("recheck-issues").onclick=()=>{if($("issues-dialog").open)$("issues-dialog").close();generate().catch(fail);};
  $("keep-issues").onclick=()=>keepIssueOriginal().catch(fail);
  $("region-overlay").onclick=()=>{state.showRegionsOverlay=!state.showRegionsOverlay;$("region-overlay").setAttribute("aria-pressed",String(!!state.showRegionsOverlay));drawRegionOverlay();};
  $("settings").onclick=()=>showSettings().catch(fail);
  window.addEventListener("keydown",e=>{if(e.key==="F11"){e.preventDefault();toggleWindowSize();}});
  $("close-settings").onclick=()=>$("settings-dialog").close();
  $("install-engine").onclick=async()=>{const button=$("install-engine");button.disabled=true;try{await bridge.engine.install(bridge,e=>{$("engine-status").textContent=e.message||"准备资源…";});$("engine-status").textContent="本机引擎已准备就绪，重新打开论文即可使用。";}catch(e){$("engine-status").textContent=message(e);}finally{button.disabled=false;}};
  $("settings-form").onsubmit=e=>{e.preventDefault();saveSettings().catch(fail);};
  $("choose-dir").onclick=async()=>{try{const p=await bridge.chooseDirectory(window);if(p)$("output-dir").value=p;}catch(e){fail(e);}};
  $("generate").onclick=()=>generate().catch(fail);
  $("cancel").onclick=()=>state.controller?.abort();
  $("native").onclick=()=>bridge.native(item).catch(fail);
  $("open-folder").onclick=()=>{if(state.index?.outputPath)bridge.reveal(state.index.outputPath);};
  $("regions").onclick=()=>{
    const draft=firstDraft();
    showRegions(draft?.id || null,draft ? "段落 "+draft.id+" 的译文尚未通过检查。请修改草稿，或取消勾选保留原文。" : "");
  };
  $("close-regions").onclick=()=>{$("regions-dialog").close();renderIssueBadge();persistCache().catch(fail);};
  $("region-page").onchange=()=>{state.focusBlock=null;renderRegions();};
  $("region-previous").onclick=()=>{$("region-page").value=Number($("region-page").value)-1;state.focusBlock=null;renderRegions();};
  $("region-next").onclick=()=>{$("region-page").value=Number($("region-page").value)+1;state.focusBlock=null;renderRegions();};
  $("page-number").onchange=()=>goPage(Number($("page-number").value));
  $("previous").onclick=()=>goPage(Number($("page-number").value)-1);
  $("next").onclick=()=>goPage(Number($("page-number").value)+1);
  $("zoom-percent").onchange=()=>scheduleZoom(Number($("zoom-percent").value)/100);
  for(const side of ["zh","en"])$("search-"+side).onclick=()=>{ $("search-side").value=side;for(const v of ["zh","en"])$("search-"+v).setAttribute("aria-pressed",String(v===side));$("search-count").textContent="";for(const shell of document.querySelectorAll(".page-shell"))highlight(shell); };
  $("zoom-in").onclick=()=>stepZoom(1);
  $("zoom-out").onclick=()=>stepZoom(-1);
  $("zoom-fit").onclick=()=>scheduleZoom("fit");
  $("viewport").addEventListener("wheel",e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();if(!e.deltaY)return;const unit=e.deltaMode===1?16:e.deltaMode===2?$("viewport").clientHeight:1;scheduleZoom(currentZoom()*Math.exp(-Math.max(-200,Math.min(200,e.deltaY*unit))*.002),{x:e.clientX,y:e.clientY});}},{passive:false});
  window.addEventListener("keydown",e=>{
    if(!(e.ctrlKey||e.metaKey))return;
    if(["+","=","-","0"].includes(e.key)){e.preventDefault();e.key==="0"?scheduleZoom("fit"):stepZoom(e.key==="-"?-1:1);}
  });
  $("search").onclick=()=>search().catch(fail);
  $("search-text").onkeydown=e=>{if(e.key==="Enter")search().catch(fail);};
  let scrollFrame=0;
  $("viewport").addEventListener("scroll",()=>{
    if(scrollFrame)return;
    scrollFrame=requestAnimationFrame(()=>{
      scrollFrame=0;
      const top=$("viewport").getBoundingClientRect().top;
      const row=state.rows.find(r=>r.getBoundingClientRect().bottom>top+50);
      if(row)$("page-number").value=row.dataset.page;
      if(!state.zoomActive)renderVisible();
    });
  });
  let resizeTimer;
  window.addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if($("zoom").value==="fit"&&state.pages.length)scheduleZoom("fit");},200);});
  window.addEventListener("beforeunload",()=>{state.controller?.abort();});
  window.addEventListener("unload",event=>{if(event.target===document){state.pdf?.destroy();state.zh?.destroy();}});
}
function renderVisible(){
  const vr=$("viewport").getBoundingClientRect();
  for(const row of state.rows){const r=row.getBoundingClientRect();if(r.bottom>=vr.top-300&&r.top<=vr.bottom+300)queueRender(Number(row.dataset.page));}
}
function bindPan(){
  const viewport=$("viewport"),button=$("pan-tool");let enabled=false,space=false,drag=null;
  const editable=e=>e.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]');
  const update=()=>{viewport.classList.toggle('pan-mode',enabled||space);button.setAttribute('aria-pressed',String(enabled));};
  const stop=()=>{if(drag&&viewport.hasPointerCapture(drag.id))viewport.releasePointerCapture(drag.id);drag=null;viewport.classList.remove('dragging');};
  button.onclick=()=>{enabled=!enabled;update();};
  window.addEventListener('keydown',e=>{if(e.code==='Space'&&!editable(e)){e.preventDefault();space=true;update();}if(e.key==='Escape'){stop();enabled=space=false;update();}});
  window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;stop();update();}});
  window.addEventListener('blur',()=>{space=false;stop();update();});
  viewport.addEventListener('pointerdown',e=>{if(e.button!==0||!(enabled||space))return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(e.pointerId);viewport.classList.add('dragging');});
  viewport.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;e.preventDefault();viewport.scrollLeft=drag.left+drag.x-e.clientX;viewport.scrollTop=drag.top+drag.y-e.clientY;});
  viewport.addEventListener('pointerup',stop);viewport.addEventListener('pointercancel',stop);viewport.addEventListener('lostpointercapture',()=>{drag=null;viewport.classList.remove('dragging');});
}
function toggleWindowSize(){
  if(window.windowState===window.STATE_MAXIMIZED)window.restore();else window.maximize();
}
function currentZoom(){return $("zoom").value==="fit"?state.scale:Number($("zoom").value);}
function stepZoom(direction,step=.25){scheduleZoom(currentZoom()+direction*step);}
function scheduleZoom(value,point=null){
  if(!state.pages.length)return;
  const viewport=$("viewport");
  const scale=value==="fit"?Math.max(.25,(viewport.clientWidth-60)/(2*Math.max(...state.pages.map(p=>p.width)))):Math.max(.25,Math.min(3,Number(value)));
  if(!Number.isFinite(scale))return;
  $("zoom").value=value==="fit"?"fit":String(scale);
  $("zoom-percent").value=Math.round(scale*100);
  $("zoom-percent").title=value==="fit"?"当前为适合双栏；输入百分比可自定义缩放":"输入 25–300";
  state.zoomActive=true;
  ++generation; // In-flight PDF raster work must not overwrite the live preview.
  zoomPending={scale,point};
  if(!zoomFrame)zoomFrame=requestAnimationFrame(applyLiveZoom);
  clearTimeout(zoomTimer);
  zoomTimer=setTimeout(()=>{
    if(zoomPending)applyLiveZoom();
    state.zoomActive=false;
    const token=generation,rect=viewport.getBoundingClientRect();
    for(const row of state.rows){const r=row.getBoundingClientRect();if(r.bottom>=rect.top-300&&r.top<=rect.bottom+300)queueRender(Number(row.dataset.page),token);}
  },160);
}
function applyLiveZoom(){
  if(zoomFrame)cancelAnimationFrame(zoomFrame);zoomFrame=0;
  if(!zoomPending)return;
  const {scale,point}=zoomPending;zoomPending=null;
  const viewport=$("viewport"),vr=viewport.getBoundingClientRect();
  const x=point?Math.max(vr.left,Math.min(vr.right,point.x)):vr.left+viewport.clientWidth/2;
  const y=point?Math.max(vr.top,Math.min(vr.bottom,point.y)):vr.top+Math.min(80,viewport.clientHeight/2);
  const row=state.rows.find(r=>r.getBoundingClientRect().bottom>y)||state.rows.at(-1);
  const shell=[...row.children].find(c=>c.getBoundingClientRect().right>x)||row.lastElementChild;
  const before=shell.getBoundingClientRect(),fx=(x-before.left)/before.width,fy=(y-before.top)/before.height;
  state.scale=scale;
  for(const [i,r] of state.rows.entries())for(const c of r.children){
    c.style.width=state.pages[i].width*scale+"px";c.style.height=state.pages[i].height*scale+"px";
    const layer=c.querySelector(".textLayer");if(layer)layer.style.transform=`scale(${scale/Number(c.dataset.renderScale||scale)})`;
  }
  const after=shell.getBoundingClientRect();
  viewport.scrollLeft+=after.left+fx*after.width-x;
  viewport.scrollTop+=after.top+fy*after.height-y;
  $("zoom-in").disabled=scale>=3;$("zoom-out").disabled=scale<=.25;
}
async function showSettings() {
  const s=bridge.getSettings();
  $("native-engine").checked=s.engine!=="legacy";
  $("engine-status").textContent="正在检查本机引擎…";
  bridge.engine.status(bridge).then(r=>{$("engine-status").textContent=r.ready?"本机引擎已安装（版面模型 "+r.version+"）。":"本机引擎尚未准备，请点击安装。";}).catch(()=>{$("engine-status").textContent="本机引擎检查失败，可点击修复。";});
  $("structure-assist").checked=s.structureAssist!==false;
  $("base-url").value=s.baseURL;$("model").value=s.model;$("output-dir").value=s.outputDir;
  $("api-key").value=await bridge.getKey();$("settings-dialog").showModal();
}
async function saveSettings() {
  if(state.busy)throw new Error("请先等待生成结束或取消，再修改设置。");
  const s={engine:$("native-engine").checked?"hybrid":"legacy",structureAssist:$("structure-assist").checked,baseURL:$("base-url").value.trim().replace(/\/+$/,""),model:$("model").value.trim(),outputDir:$("output-dir").value.trim()};
  const stored=await bridge.saveSettings(s,$("api-key").value,$("remember").checked);
  $("api-key").value="";$("settings-dialog").close();
  status(stored?"设置已保存，API Key 存在本机凭据库。":"设置已保存；API Key 仅在本次 Zotero 会话使用。");
  if(state.source && s.engine!==(state.native?"native":state.hybrid?"hybrid":"legacy")){status("设置已保存。重新打开这篇论文后切换处理引擎；已有译版与缓存均保留。");return;}
  if(state.source && !state.native) {
    state.paths=await bridge.paths(state.source.key);
    await loadCache(s);
    rebuildStructure();decisionStore(state.cache).requests={};
    resetAttempts(recovery(state.cache),logicalJobs(selected().filter(b=>!translationCurrent(b,state.cache.translations[b.id]))));recovery(state.cache).issues=recovery(state.cache).issues.filter(i=>!i.service);await persistCache();renderIssueBadge();
  }
}
async function cachePath(settings,engine) {
  const key=await hash(new TextEncoder().encode(settings.baseURL+"|"+settings.model+"|"+engine));
  return state.paths.dir+"\\"+state.source.key+"-"+state.source.hash.slice(0,12)+"-"+key.slice(0,12)+".json";
}
async function loadCache(settings) {
  state.cachePath=await cachePath(settings,state.outputEngine);
  let cached=await bridge.json(state.cachePath);
  state.fromLegacy=false;
  if(!cached&&!state.hybrid)for(const oldEngine of ["1.0.11","1.0.10","1.0.9","1.0.8","1.0.7","1.0.6","1.0.5","1.0.4","1.0.3","1.0.2","1.0.1","1.0.0"]){
    cached=await bridge.json(await cachePath(settings,oldEngine));
    if(cached){state.fromLegacy=true;break;}
  }
  state.cache=cached||{sourceHash:state.source.hash,engine:state.outputEngine,model:settings.model,translations:{},drafts:{},selection:{},selectionSources:{},layoutRevision:LAYOUT_REVISION,selectionOverrides:{}};
  if(cached&&cached.layoutRevision!==LAYOUT_REVISION){
    const backup=state.cachePath+".before-layout"+LAYOUT_REVISION+".json";
    if(!await bridge.json(backup))await bridge.writeJSON(backup,cached);
  }
  state.cache.translations ||= {};
  state.cache.drafts ||= {};
  state.cache.selection ||= {};
  state.cache.selectionSources ||= {};
}
function reconcileCache(){
  const sourceRevised=state.cache.layoutRevision!==LAYOUT_REVISION;
  if(sourceRevised){const old=recovery(state.cache);old.issues=[];old.layout=null;old.repairs={};}
  migrateCache(state.pages,state.cache);
  state.cache.engine=state.outputEngine;syncLayoutOverrides();
  const symbolsStore=recovery(state.cache);
  symbolsStore.issues=symbolsStore.issues.map(i=>{
    if(i.code!=="font_missing"||!/^U\+[0-9A-F]+$/i.test(i.detail))return i;
    const c=String.fromCodePoint(parseInt(i.detail.slice(2),16));return {...i,blockIDs:i.blockIDs.filter(id=>!state.cache.translations[id]||state.cache.translations[id].text.includes(c))};
  }).filter(i=>i.blockIDs.length||i.service);
  recoverDrafts(state.pages,state.cache);
  if(sourceRevised||state.index?.sourceHash===state.source.hash){
    const store=recovery(state.cache);store.issues=uniqueIssues([...store.issues.filter(i=>i.stage!=="preflight"),...sourcePreflight(state.pages),...auditSource(state.pages)]);const known=new Set(store.issues.flatMap(i=>i.blockIDs));
    for(const b of selected())if(!translationCurrent(b,state.cache.translations[b.id])&&!known.has(b.id))store.issues.push(problem("translation_missing","当前识别的完整段落尚无有效译文；可在问题列表一键补译。",[b.id]));
  }
  state.fromLegacy=false;
  return true;
}
function rebuildStructure(){
  finalizeDocument(state.pages,{...decisionStore(state.cache),selectionOverrides:state.cache.selectionOverrides});
  state.structure=state.pages.structure;reconcileCache();
}
function selected(){return state.pages.flatMap(p=>p.blocks.filter(b=>b.selected));}
function firstDraft(){return selected().find(b=>state.cache?.drafts?.[b.id]?.source===b.text);}
async function persistCache() {
  if(!state.cache||!state.cachePath)return;
  for(const p of state.pages)for(const b of p.blocks){
    state.cache.selection[b.id]=b.selected;
    state.cache.selectionSources[b.id]=b.text;
  }
  const path=state.cachePath,snapshot=JSON.parse(JSON.stringify(state.cache));
  state.cacheWriteChain=(state.cacheWriteChain||Promise.resolve()).catch(()=>{}).then(()=>bridge.writeJSON(path,snapshot));
  try{await state.cacheWriteChain;}catch(_){const e=new Error("缓存保存失败，已暂停请求；本次结果尚未全部写入磁盘，请检查保存文件夹。");e.code="storage_io";throw e;}
}
function currentIssues(){
  if(!state.cache)return [];
  const blocks=selected(),ids=new Set(blocks.map(b=>b.id));
  return recovery(state.cache).issues.map(i=>({...i,blockIDs:i.blockIDs.filter(id=>ids.has(id)||(i.code==="source_structure"&&state.structure?.uncertainNodes.some(n=>n.id===id)))})).filter(i=>i.blockIDs.length||i.service);
}
function issueSummary(){
  const issues=currentIssues(),ids=new Set(issues.flatMap(i=>i.blockIDs));
  const blocks=selected(),done=blocks.filter(b=>translationCurrent(b,state.cache.translations[b.id])).length;
  return completionMessage({done,total:blocks.length,groups:groupedIssues(issues).length,pending:ids.size,saved:state.savedOutputAvailable,preview:!!state.readingPreview});
}
function validationIssuesFor(b,text){
  try{
    validateParagraph(b,text);
    return auditScientificDocument(state.pages,{...Object.fromEntries(Object.entries(state.cache.translations).filter(([,t])=>t?.text).map(([id,t])=>[id,t.text])),[b.id]:text}).filter(i=>i.blockIDs.includes(b.id));
  }catch(e){return e.issues||[classify(e,[b.id])];}
}
function drawReadingMarkers(){
  document.querySelectorAll(".reading-marker").forEach(el=>el.remove());
  $("translation-label").textContent=state.readingPreview?"中文阅读预览 · 标记处待处理":"中文译版 · 可选择、搜索和复制文字";
  if(!state.readingPreview)return;
  const pending=new Set(state.readingPreview.pending);
  for(const row of state.rows){const p=state.pages[Number(row.dataset.page)-1],shell=row.children[1];if(!shell?.querySelector("canvas"))continue;
    for(const b of p.blocks.filter(b=>pending.has(b.id))){const mark=document.createElement("button");mark.className="reading-marker";mark.type="button";mark.textContent="待处理 · 保留原文";mark.title="这处内容尚未完成，点击查看自动处理结果";
      mark.style.cssText="left:"+(100*b.x/p.width)+"%;top:"+(100*b.y/p.height)+"%;width:"+(100*b.w/p.width)+"%;height:"+(100*b.h/p.height)+"%;";mark.onclick=()=>showIssues();shell.append(mark);
    }
  }
}
async function showReadingPreview(texts=null,fontBytes=null,preparedBytes=null){
  if(state.native||!state.pages.length)return false;
  const initial=texts||Object.fromEntries(selected().filter(b=>translationCurrent(b,state.cache.translations[b.id])).map(b=>[b.id,state.cache.translations[b.id].text]));
  let safe={...initial},bytes=preparedBytes,failed=currentIssues().filter(i=>i.stage==="layout"||i.stage==="preflight").flatMap(i=>i.blockIDs);
  const exclude=ids=>{const set=new Set(ids);for(const j of logicalJobs(selected()))if((j.members||[j]).some(b=>set.has(b.id)))for(const b of j.members||[j])delete safe[b.id];};
  exclude(failed);if(Object.keys(safe).length!==Object.keys(initial).length)bytes=null;
  fontBytes ||= await bridge.readPDFFonts();
  for(let pass=0;pass<3&&!bytes;pass++){
    if(!Object.keys(safe).length)return false;
    const pages=state.pages.map(p=>({...p,blocks:p.blocks.map(b=>({...b,selected:b.selected&&!!safe[b.id]}))}));
    try{bytes=await makePDF(pages,safe,state.pdf,{PDFLib:window.PDFLib,fontkit:window.fontkit},fontBytes,state.controller?.signal,()=>{});}
    catch(e){const ids=e.issues?.flatMap(i=>i.blockIDs)||[];if(!ids.length)return false;const before=Object.keys(safe).length;exclude(ids);if(Object.keys(safe).length===before)return false;}
  }
  if(!bytes)return false;
  const preview=await openPDF(bytes);
  if(preview.numPages!==state.pdf.numPages){await preview.destroy();return false;}
  await stopRendering();await state.zh?.destroy();state.zh=preview;state.searchKey=null;
  state.readingPreview={pending:selected().filter(b=>!safe[b.id]).map(b=>b.id),translated:Object.keys(safe).length};
  await Promise.race([buildRows(),new Promise(resolve=>setTimeout(resolve,8000))]);drawReadingMarkers();return true;
}
function renderIssueBadge(){
  if(state.native){nativeControls();return;}
  const issues=currentIssues(),groups=groupedIssues(issues);$("issues").disabled=!state.source;
  $("issues").textContent="问题列表"+(groups.length?"（"+groups.length+"）":"");
  $("recovery").hidden=true; // Recovery actions live in the single problem panel.
  $("read-completed").disabled=state.busy||state.repairing||!issues.length||!selected().some(b=>translationCurrent(b,state.cache.translations[b.id]));
  drawReadingMarkers();
  if($("issues-dialog").open)renderIssues();
}
function showIssues(){if(state.native){$("issues-summary").textContent=state.nativeError||"当前没有待处理问题。";$("issues-list").replaceChildren();$("retry-issues").disabled=state.busy;$("recheck-issues").disabled=state.busy;$("keep-issues").disabled=state.busy||!(state.nativeRegions||[]).some(r=>r.error&&!r.hardProtected);const groups=new Map();for(const r of state.nativeRegions||[])if(r.error){if(!groups.has(r.error))groups.set(r.error,[]);groups.get(r.error).push(r);}for(const [cause,rows] of groups){const section=document.createElement("section");section.className="issue-group";const p=document.createElement("p");p.textContent=cause+" · "+rows.length+" 段";section.append(p);for(const r of rows){const b=document.createElement("button");b.textContent="第 "+r.page+" 页 · "+r.id;b.onclick=()=>{$("issues-dialog").close();$("region-page").value=r.page;showRegions();};section.append(b);}$("issues-list").append(section);}$("issues-dialog").showModal();return;}renderIssues();if(!$("issues-dialog").open)$("issues-dialog").showModal();}
function fromIssues(dialog,open){
  state.issueReturn={dialog,scroll:$("issues-list").scrollTop};$("issues-dialog").close();
  $("close-regions").textContent="返回问题列表";$("close-structure").textContent="返回问题列表";$("close-preview").textContent="返回问题列表";
  open();
}
function renderIssues(){
  const issues=currentIssues(),groups=groupedIssues(issues),list=$("issues-list");list.replaceChildren();
  $("issues-summary").textContent=(state.repairMessage?state.repairMessage+" ":"")+(groups.length?issueSummary():"当前没有待处理问题。生成时会先检查全文，再检查完整译文的字体与排版。");
  for(const group of groups){
    const section=document.createElement("section");section.className="issue-group";
    const heading=document.createElement("h3");heading.textContent=(titles[group.code]||"待检查问题")+(group.detail?" · "+group.detail:"")+" · "+group.blockIDs.length+" 段";
    const guidance=issueGuidance(group);
    const note=document.createElement("p");note.textContent=guidance.hint;
    const locations=document.createElement("div");locations.className="issue-locations";
    for(const id of group.blockIDs){
      const b=state.pages.flatMap(p=>p.blocks).find(b=>b.id===id);if(!b)continue;
      const row=document.createElement("div");row.className="issue-row";
      const label=document.createElement("strong");label.textContent="第 "+b.page+" 页 · "+(b.kind||"正文");label.title=id;
      const excerpt=document.createElement("p");excerpt.className="issue-excerpt";excerpt.textContent=visibleSymbols(b.text).slice(0,240)+(b.text.length>240?"…":"");
      const ownIssue=issues.find(i=>i.code===group.code&&i.blockIDs.includes(id))||group;
      const reason=document.createElement("p");reason.className="issue-reason";reason.textContent=ownIssue.message;
      const evidence=ownIssue.geometry;
      if(evidence?.retainedID){const detail=document.createElement("small");detail.textContent="冲突原文："+evidence.retainedID+" · "+evidence.retainedText;row.append(detail);}
      const button=document.createElement("button");button.textContent="手动检查";button.disabled=state.busy||state.repairing;
      button.onclick=()=>fromIssues("regions-dialog",()=>{goPage(b.page);showRegions(id,group.message);});
      row.append(label,reason,excerpt,button);
      const draft=resolveDraft(state.pages,state.cache,b);
      if(draft){
        const preview=document.createElement("button");preview.textContent=draft.scope==="paragraph"?"查看完整段落草稿":"查看原文与译文";preview.disabled=state.busy||state.repairing;
        preview.onclick=()=>fromIssues("preview-dialog",()=>previewDraft(b,draft).catch(fail));row.append(preview);
      }else{const detail=document.createElement("small");detail.textContent="这一处尚无译文，插件会单独补译；已完成内容可先阅读。";row.append(detail);}
      locations.append(row);
    }
    section.append(heading,note);
    const repair=document.createElement("button");repair.textContent=guidance.action;repair.disabled=state.busy||state.repairing;
    const handled=recovery(state.cache).repairs?.[[...group.blockIDs].sort().join(",")];
    if(handled?.stamp===repairStamp(state.pages,state.cache,[...group.blockIDs].sort())){repair.disabled=true;repair.textContent="已自动处理，查看对照";}
    repair.onclick=()=>repairIssues(group.blockIDs).catch(fail);section.append(repair,locations);
    if(["source_structure","layout_space","layout_image","layout_retained"].includes(group.code)){const inspect=document.createElement("button");inspect.textContent="检查阅读顺序和段落连接";inspect.disabled=state.busy;inspect.onclick=()=>fromIssues("structure-dialog",()=>showStructure(group.blockIDs[0]));section.append(inspect);}
    list.append(section);
  }
  $("auto-repair").disabled=state.busy||state.repairing||!groups.length;
  $("auto-repair").textContent=state.repairing?"正在修复…":"一键修复可自动处理项";
  $("supplement-font").disabled=state.busy||state.repairing;
  $("retry-issues").disabled=state.busy||!issues.some(i=>i.retryable);
  $("recheck-issues").disabled=state.busy||!groups.length;
  $("keep-issues").disabled=state.busy||!issues.some(i=>i.blockIDs.length&&!i.service);
}
async function chooseSupplementFont(){
  if(state.busy)return;
  const selected=await bridge.chooseSupplementFont(window);if(!selected)return;
  const v=new DataView(selected.bytes.buffer,selected.bytes.byteOffset,selected.bytes.byteLength);
  const count=v.getUint32(0)===0x74746366?Math.min(16,v.getUint32(8)):1,covered=new Set();
  for(let index=0;index<count;index++){const face=window.fontkit.create(extractFont(selected.bytes,index));for(const c of face.characterSet)covered.add(c);}
  const missing=currentIssues().filter(i=>i.code==="font_missing").map(i=>parseInt(i.detail.replace("U+",""),16));
  if(missing.length&&!missing.some(code=>covered.has(code)))throw new Error("该字体没有覆盖当前缺少的字符；未添加，请选择其他字体。");
  bridge.addSupplementFont(selected.path);state.previewFonts=null;recovery(state.cache).layout=null;
  $("issues-summary").textContent="补充字体已添加，只用于首选字体缺字的位置。点击“继续生成／重新检查”验证全文，不需要重新翻译。";
}
async function repairIssues(ids=null){
  if(state.busy||state.repairing)return;
  if(state.native)return retryIssues();
  const store=recovery(state.cache),before=new Set(currentIssues().flatMap(i=>i.blockIDs)),scope=ids?[...ids].sort():null,key=scope?.join(",")||"all";
  store.repairs ||= {};
  if(store.repairs[key]?.stamp===repairStamp(state.pages,state.cache,scope)){
    state.repairMessage="这些内容已自动处理过，仍需手动检查的项目已列在下方；未再次调用翻译。";renderIssues();return;
  }
  state.repairing=true;state.repairMessage="先复核已有草稿与科研缩写，再补译缺失完整段落、重新拟合排版…";renderIssues();
  let failure=null;const previousOutput=state.index?.created;
  try{
    rebuildStructure();store.layout=null;await persistCache();
    const jobs=logicalJobs(selected()).filter(j=>!scope||(j.members||[j]).some(b=>scope.includes(b.id)));
    // A user-triggered recovery gets one bounded batch; subsequent identical
    // clicks cannot reset the persisted budget. Explicit retry stays separate.
    store.repairResets ||= {};
    if(!store.service)for(const j of jobs){const stamp=jobStamp(j);if(!canAttempt(store,j)&&!store.repairResets[stamp])delete store.attempts[j.id];store.repairResets[stamp]=true;}
    await generate({onlyIDs:scope});
  }catch(e){if(!e.issues)failure=message(e);}
  finally{
    const remaining=new Set(currentIssues().flatMap(i=>i.blockIDs)),fixed=[...before].filter(id=>!remaining.has(id)).length;
    state.repairMessage=(failure?"修复已暂停："+failure+"。 ":"")+"本次解决 "+fixed+" 个片段；剩余 "+remaining.size+" 个。"+(remaining.size?"未通过的项目保留草稿与冲突说明，可在下方手动检查。":state.index?.created!==previousOutput?"已完成全文检查并保存译版。":"已有结果已保留。");
    store.repairs[key]={stamp:repairStamp(state.pages,state.cache,scope),at:new Date().toISOString(),remaining:remaining.size};
    state.repairing=false;await persistCache();renderIssueBadge();showIssues();
  }
}
async function retryIssues(){
  if(state.native){$("issues-dialog").close();return generateNative({retry:true});}
  if(state.busy)return;
  const store=recovery(state.cache),ids=new Set(currentIssues().filter(i=>i.retryable).flatMap(i=>i.blockIDs));
  const jobs=logicalJobs(selected()).filter(j=>ids.has(j.id)||j.members?.some(b=>ids.has(b.id)));
  if(currentIssues().some(i=>i.service))decisionStore(state.cache).requests={};
  resetAttempts(store,jobs);store.issues=store.issues.filter(i=>!i.retryable);await persistCache();
  if($("issues-dialog").open)$("issues-dialog").close();return generate();
}
async function keepIssueOriginal(){
  if(state.native){if(state.busy)return;const path=state.nativeCachePath||state.index?.nativeCachePath,cache=await bridge.json(path);cache.selectionOverrides ||= {};for(const r of state.nativeRegions||[])if(r.error&&!r.hardProtected)cache.selectionOverrides[r.sourceStamp]=true;await bridge.writeJSON(path,cache);$("issues-dialog").close();return generateNative();}
  if(state.busy)return;
  const ids=new Set(currentIssues().filter(i=>!i.service).flatMap(i=>i.blockIDs));
  const paragraphs=new Set(selected().filter(b=>ids.has(b.id)).map(b=>b.paragraphID||b.id));
  for(const b of selected())if(paragraphs.has(b.paragraphID||b.id)){
    b.selected=false;state.cache.selectionOverrides[b.id]={source:b.text,selected:false,origin:"issue-recovery"};
  }
  for(const n of state.structure?.uncertainNodes||[])if(ids.has(n.id))decisionStore(state.cache).labels[n.id]={stamp:n.stamp,role:"label",origin:"manual"};
  rebuildStructure();recovery(state.cache).layout=null;await persistCache();renderIssueBadge();
  if($("issues-dialog").open)$("issues-dialog").close();return generate();
}
function clearTranslationIssues(ids){
  const store=recovery(state.cache),set=new Set(ids);
  store.issues=store.issues.map(i=>i.stage==="translation"&&!i.service?{...i,blockIDs:i.blockIDs.filter(id=>!set.has(id))}:i).filter(i=>i.blockIDs.length||i.service);
}
function showQuality(){
 if(state.native){const list=$("quality-list");list.replaceChildren();const p=document.createElement("p");p.textContent=state.index?.engine===bridge.engine.version?"本机引擎已检查页数、页面尺寸、可搜索中文和原件哈希。区域识别及译义仍需阅读复核；不代表所有公式、图表或期刊均无误。":"本机引擎尚未生成当前论文的译版。";list.append(p);$("quality-dialog").showModal();return;}
 const q=state.quality||state.index?.quality,list=$("quality-list");list.replaceChildren();
 const audit=symbolSummary(state.pages),symbols=document.createElement("p");symbols.textContent=`科学符号：原字形保护 ${audit.protected} 处，字体映射恢复 ${audit.mapped} 处，人工确认 ${audit.confirmed} 处，待确认 ${audit.unresolved} 处。生成前核对数值、正负号和单位。`;list.append(symbols);
 if(q){const intro=document.createElement("p");intro.textContent=`已完成 ${q.translated}/${q.selected} 段译文；${q.unresolved} 项未解决问题，另有 ${q.retainedBody||0} 段正文按已保存选择保留原文。`+q.limits;list.append(intro);for(const p of q.pages){const row=document.createElement("p");row.textContent=`第 ${p.page} 页：${p.translated}/${p.selected} 段，${p.moved} 段利用同栏空白调整位置`+(p.smallestFont?`，最小字号 ${p.smallestFont.toFixed(2)} pt`:"");list.append(row);}}
 else list.textContent="生成时会自动检查完整性、公式和图表保护以及字形重叠。尚未生成本版本检查结果。";
 if(!$("quality-dialog").open)$("quality-dialog").showModal();
}
function showStructure(focusID=null){
  if(focusID){state.structurePage=Number(focusID.match(/^p(\d+)/)?.[1]||1);state.structureFocus=focusID;}
  renderStructure();if(!$("structure-dialog").open)$("structure-dialog").showModal();
}
function renderStructure(){
  const graph=state.structure,list=$("structure-list");list.replaceChildren();if(!graph)return;
  $("structure-summary").textContent=`${state.pages.length} 页，${state.pages.reduce((n,p)=>n+p.structure.flows.length,0)} 个正文区域，${graph.candidates.length} 处连接及 ${graph.uncertainNodes.length} 个区域待确认。可修改自动或模型已经确认的连接。`;
  const addButton=(container,label,action)=>{const button=document.createElement("button");button.textContent=label;button.disabled=state.busy;button.onclick=()=>action().catch(fail);container.append(button);};
  const finish=async()=>{rebuildStructure();recovery(state.cache).layout=null;recovery(state.cache).issues=recovery(state.cache).issues.filter(i=>i.code!=="source_structure");await persistCache();renderStructure();renderIssueBadge();drawRegionOverlay();};
  for(const e of [...graph.edges].sort((a,b)=>(b.decision==="uncertain")-(a.decision==="uncertain"))){
    const a=graph.byID[e.from],b=graph.byID[e.to],row=document.createElement("section");row.className="structure-item";
    const title=document.createElement("h3");title.textContent=`${e.from} → ${e.to} · ${e.decision==="join"?"同一段":e.decision==="separate"?"独立段落":"待确认"} · ${e.evidence}`;
    const source=document.createElement("p");source.textContent=a.text.slice(-230)+" ⟶ "+b.text.slice(0,230);row.append(title,source);
    for(const [join,label] of [[true,"合为同一段"],[false,"保持独立段落"]])addButton(row,label,async()=>{decisionStore(state.cache).links[e.id]={stamp:e.stamp,join,origin:"manual"};await finish();});
    addButton(row,"查看原文位置",async()=>{$("structure-dialog").close();state.showRegionsOverlay=true;drawRegionOverlay();goPage(a.page);});list.append(row);
  }
  for(const n of [...graph.uncertainNodes,...graph.reviewNodes]){const row=document.createElement("section");row.className="structure-item";const text=document.createElement("p");text.textContent=n.id+(n.role?" · 已确认"+(roleNames[n.role]||n.role):" · 待确认")+" · "+n.text;row.append(text);for(const role of n.allowedRoles)addButton(row,roleNames[role],async()=>{decisionStore(state.cache).labels[n.id]={stamp:n.stamp,role,origin:"manual"};delete state.cache.selectionOverrides[n.id];await finish();});list.append(row);}
  const details=document.createElement("details"),summary=document.createElement("summary");summary.textContent="检查或修正整页区域类别";details.open=!!(state.structureFocus||state.structureExpanded);details.ontoggle=()=>{state.structureExpanded=details.open;};details.append(summary);
  const control=document.createElement("label");control.textContent="查看第 ";const input=document.createElement("input");input.type="number";input.min=1;input.max=state.pages.length;input.value=state.structurePage||Number($("page-number").value)||1;input.setAttribute("aria-label","结构检查页码");input.disabled=state.busy;input.onchange=()=>{state.structurePage=Math.max(1,Math.min(state.pages.length,Number(input.value)||1));state.structureFocus="page";renderStructure();};control.append(input,document.createTextNode(" 页"));details.append(control);
  const page=state.pages[Number(input.value)-1];
  for(const n of page?.structure.nodes||[]){if(["formula","references","table","running"].includes(n.role))continue;const b=page.blocks.find(b=>b.id===n.id),row=document.createElement("section");row.className="structure-item";row.dataset.regionId=n.id;const text=document.createElement("p");text.textContent=n.id+" · "+roleNames[n.role]+" · "+b.text.slice(0,230);row.append(text);
    for(const role of ["body","abstract","heading","caption","metadata","label"])addButton(row,roleNames[role],async()=>{decisionStore(state.cache).labels[n.id]={stamp:n.stamp,role,origin:"manual"};delete state.cache.selectionOverrides[n.id];await finish();});details.append(row);
  }
  list.append(details);
  $("reanalyze-structure").disabled=state.busy||(!graph.candidates.length&&!graph.uncertainNodes.length);
}
function drawRegionOverlay(){
  for(const layer of document.querySelectorAll(".region-overlay"))layer.remove();
  if(!state.showRegionsOverlay)return;
  for(const shell of document.querySelectorAll('.page-shell[data-side="en"]')){
    const p=state.pages[Number(shell.closest(".page-pair").dataset.page)-1];if(!p||!shell.querySelector("canvas"))continue;
    const layer=document.createElement("div");layer.className="region-overlay";
    for(const [items,className] of [[p.structure?.flows||[],"flow-box"],[p.visualRegions||[],"image-box"]])for(const r of items){const box=document.createElement("div");box.className=className;box.style.cssText=`left:${100*r.x/p.width}%;top:${100*r.y/p.height}%;width:${100*r.w/p.width}%;height:${100*r.h/p.height}%;`;box.textContent=r.id||"图片保护";layer.append(box);}
    const bad=new Set(currentIssues().flatMap(i=>i.blockIDs));
    for(const b of p.blocks){const box=document.createElement("div");box.className="region-box"+(bad.has(b.id)?" issue-box":"");box.style.cssText="left:"+(100*b.x/p.width)+"%;top:"+(100*b.y/p.height)+"%;width:"+(100*b.w/p.width)+"%;height:"+(100*b.h/p.height)+"%;";box.textContent=(roleNames[b.role]||b.kind)+" · "+b.id+(b.paragraphID!==b.id?" → "+b.paragraphID:"");layer.append(box);}
    shell.append(layer);
  }
}
function showRegions(focusID=null,issue="") {
  if(state.native){renderNativeRegions();$("regions-dialog").showModal();return;}
  if(focusID){
    state.focusBlock=focusID;
    $("region-page").value=Number(focusID.match(/^p(\d+)b/)?.[1]||1);
    $("region-issue").textContent=issue || "请检查段落 "+focusID+" 的译文，或取消勾选保留原文。";
    $("region-issue").hidden=false;
  }else{
    state.focusBlock=null;
    $("region-issue").hidden=true;
  }
  renderRegions();
  if(!$("regions-dialog").open)$("regions-dialog").showModal();
  if(focusID)requestAnimationFrame(()=>{
    const row=[...$("region-list").children].find(el=>el.dataset.blockId===focusID);
    row?.scrollIntoView({block:"start"});
  });
}
function appendSymbolReview(container,b){
 if(!b.symbols?.length)return;
 const details=document.createElement("details"),summary=document.createElement("summary");summary.textContent="原文符号核对（"+b.symbols.length+"处；未确认的使用原字形）";details.append(summary);
 const show=document.createElement("button"),canvas=document.createElement("canvas");show.textContent="查看原文局部";show.type="button";canvas.hidden=true;canvas.style.maxWidth="100%";
 show.onclick=async()=>{show.disabled=true;try{
  const page=await state.pdf.getPage(b.page),vp=page.getViewport({scale:2}),full=document.createElement("canvas");full.width=Math.ceil(vp.width);full.height=Math.ceil(vp.height);await page.render({canvasContext:full.getContext("2d"),viewport:vp}).promise;
  const x=Math.max(0,b.x-12),y=Math.max(0,b.y-12),w=Math.min(state.pages[b.page-1].width-x,b.w+24),h=Math.min(state.pages[b.page-1].height-y,b.h+24);canvas.width=Math.ceil(w*2);canvas.height=Math.ceil(h*2);canvas.getContext("2d").drawImage(full,x*2,y*2,w*2,h*2,0,0,canvas.width,canvas.height);canvas.hidden=false;full.width=full.height=0;
 }catch(e){show.textContent=message(e);}finally{show.disabled=false;}};details.append(show,canvas);
 for(const e of b.symbols){
  const row=document.createElement("div"),note=document.createElement("p");note.textContent=e.detail+" → "+(e.method==="original-glyph"?e.token+"：保留原字形，不猜测":e.method==="unresolved"?"待确认完整片段":e.method==="manual"?"已按你的确认恢复":"已按字体映射恢复")+"。";
  const input=document.createElement("textarea");input.rows=e.legacy.length>28?3:1;input.value=["manual","font-map"].includes(e.method)&&!e.token?e.target:"";input.placeholder=e.legacy.length>28?"对照上方原文图片，输入此片段的完整正确原文（仅修正异常符号）":"对照原文后输入正确符号；留空继续使用原字形";input.setAttribute("aria-label","确认原文符号 "+b.id+" "+e.sourceIndex);
  const save=document.createElement("button"),feedback=document.createElement("small");save.textContent="确认此处原符号";save.type="button";save.disabled=state.busy;
  save.onclick=async()=>{try{
   const value=input.value.trim();if(!value||visibleSymbols(value)!==value)throw new Error("请输入确认后的正确符号或片段，不能含控制字符或编码占位文字。");
   state.cache.symbolOverrides ||= {};state.cache.symbolOverrides[b.page+"|"+e.sourceIndex]={source:e.legacy,replacement:value,blockSource:b.symbolOriginal.text};
   const page=state.pages[b.page-1];guardSourceBlocks(page.blocks,page.symbolHints,state.cache.symbolOverrides,page.number);rebuildStructure();recovery(state.cache).layout=null;await persistCache();renderIssueBadge();renderRegions();status("已保存此处原符号。有效译文按原文位置迁移；再次生成时复核全文。");
  }catch(error){feedback.textContent=message(error);}};
  row.append(note,input,save,feedback);details.append(row);
 }
 container.append(details);
}

function renderRegions() {
  if(state.native)return renderNativeRegions();
  const number=Math.max(1,Math.min(state.pages.length,Number($("region-page").value)||1));
  $("region-page").value=number;
  const page=state.pages[number-1];if(!page)return;
  const target=$("region-list");target.replaceChildren();
  goPage(page.number);
  for(const b of page.blocks) {
    const el=document.createElement("section");el.className="region";el.dataset.blockId=b.id;
    if(b.id===state.focusBlock)el.classList.add("needs-attention");
    const label=document.createElement("label"),check=document.createElement("input");
    check.type="checkbox";check.checked=b.selected;check.disabled=state.busy||locked(b);
    check.onchange=()=>{
      for(const member of state.pages.flatMap(p=>p.blocks).filter(other=>other.paragraphID===b.paragraphID)){
        if(locked(member))continue;
        member.selected=check.checked;
        state.cache.selectionOverrides[member.id]={source:member.text,selected:member.selected,origin:"manual"};
      }
      for(const section of target.children){
        const member=state.pages.flatMap(p=>p.blocks).find(x=>x.id===section.dataset.blockId);
        if(member)section.querySelector('input[type="checkbox"]').checked=member.selected;
      }
      $("generate").disabled=!selected().length||state.busy;
      if(!b.selected && b.id===state.focusBlock){
        $("region-issue").textContent="段落 "+b.id+" 将保留原文。点击“完成”后可继续生成中文 PDF。";
      }
    };
    label.append(check,document.createTextNode((roleNames[b.role]||b.kind)+" · "+b.id+(b.reason?(b.selected?" · 已勾选，原本建议保留："+b.reason:" · 默认保留："+b.reason):"")));
    const source=document.createElement("p");source.textContent=visibleSymbols(b.text);
    el.append(label,source);
    appendSymbolReview(el,b);
    if(b.paragraphContext){
      const note=document.createElement("p");note.className="continuation-note";
      note.textContent="同一段的续接片段："+b.paragraphContext.fragments.map(f=>"第 "+f.page+" 页（"+f.id+"）").join("、")+"。将结合完整段落翻译，勾选状态联动。";
      el.append(note);
    }
    if(b.reason==="跨栏文本"){
      const note=document.createElement("small");
      note.textContent="该文本跨越双栏，自动替换可能压住其他段落，已保留英文原样。";
      el.append(note);
    }
    const resolved=resolveDraft(state.pages,state.cache,b);
    const job=resolved?.scope==="paragraph"?resolved.job:null;
    const paragraphDraft=resolved?.scope==="paragraph"?resolved.entry:null;
    if(paragraphDraft){
      const note=document.createElement("p");note.textContent="完整续段草稿：修正后会分配回关联页面；公式标记采用下方草稿的统一编号。";
      const area=document.createElement("textarea");area.value=paragraphDraft.text;
      const save=document.createElement("button");save.textContent="保存完整段落修改";
      save.onclick=async()=>{try{
        const values=splitLogical(job,area.value);
        for(const member of job.members)state.cache.translations[member.id]={source:member.text,text:values[member.id],paragraphSource:member.paragraphSource,continuous:1,manual:true};
        delete state.cache.paragraphDrafts[job.id];clearTranslationIssues(job.members.map(b=>b.id));await persistCache();renderIssueBadge();renderRegions();
      }catch(e){note.textContent=message(e);}};
      el.append(note,area,save);
    }
    const translated=state.cache?.translations[b.id];
    const draft=state.cache?.drafts?.[b.id]?.source===b.text ? state.cache.drafts[b.id] : null;
    if(translated || draft || (b.id===state.focusBlock&&!paragraphDraft)){
      if(draft && !translated){
        const note=document.createElement("p");
        const causes=validationIssuesFor(b,draft.text);note.textContent=causes.length?validationMessage(causes):"这段草稿已通过本机复核，可直接采用，不需要重新翻译。";
        el.append(note);
      }
      const area=document.createElement("textarea");
      area.value=translated?.text || draft?.text || "";
      area.disabled=state.busy;
      area.setAttribute("aria-label","译文 "+b.id);
      const save=document.createElement("button");
      save.type="button";save.textContent="保存这段修改";save.disabled=state.busy;
      const feedback=document.createElement("small");feedback.hidden=true;
      save.onclick=async()=>{
        try {
          const value=validateParagraph(b,area.value);
          state.cache.translations[b.id]={source:b.text,text:value,paragraphSource:b.paragraphSource,manual:true};
          delete state.cache.drafts[b.id];
          clearTranslationIssues([b.id]);await persistCache();renderIssueBadge();
          state.focusBlock=null;
          $("region-issue").textContent="已保存段落 "+b.id+"。点击“完成”后继续生成中文 PDF。";
          $("region-issue").hidden=false;
          status("已保存段落 "+b.id+"。可以继续生成。");
          renderRegions();
        }catch(e){feedback.textContent=message(e);feedback.hidden=false;}
      };
      const layout=document.createElement("button");layout.type="button";layout.textContent="排版调整与预览";layout.disabled=state.busy;
      layout.disabled=state.busy||!area.value.trim();
      area.addEventListener("input",()=>{layout.disabled=state.busy||!area.value.trim();});
      layout.onclick=()=>previewParagraph(b.id,area.value).catch(e=>{feedback.textContent=message(e);feedback.hidden=false;});
      el.append(area,save,layout,feedback);
    }
    if(b.selected&&!translationCurrent(b,state.cache.translations[b.id])){
      const repair=document.createElement("button");repair.textContent="自动修复此完整段落";repair.disabled=state.busy;
      repair.onclick=()=>{const ids=(job?.members||[b]).map(v=>v.id);$("regions-dialog").close();repairIssues(ids).catch(fail);};el.append(repair);
    }
    target.append(el);
  }
}
let generation=0;
const renderTasks=new Set();
async function stopRendering(){
  const token=++generation;
  for(const task of renderTasks)task.cancel();
  await state.renderChain.catch(()=>{});return token;
}
async function buildRows() {
  if(!state.pdf||!state.pages.length)return;
  clearTimeout(zoomTimer);if(zoomFrame)cancelAnimationFrame(zoomFrame);zoomFrame=0;zoomPending=null;state.zoomActive=false;
  const current=Number($("page-number").value)||1;
  state.observer?.disconnect();
  const token=await stopRendering();
  if(token!==generation)return;
  const maxWidth=Math.max(...state.pages.map(p=>p.width));
  state.scale=$("zoom").value==="fit"?Math.max(.25,($("viewport").clientWidth-60)/(2*maxWidth)):Number($("zoom").value);
  $("zoom-percent").value=Math.round(state.scale*100);
  const container=$("pages");container.replaceChildren();state.rows=[];
  for(const p of state.pages) {
    const row=document.createElement("div");row.className="page-pair";row.dataset.page=p.number;
    for(const side of ["en","zh"]) {
      const shell=document.createElement("div");shell.className="page-shell";shell.dataset.side=side;
      shell.style.width=p.width*state.scale+"px";shell.style.height=p.height*state.scale+"px";
      const placeholder=document.createElement("div");placeholder.className="placeholder";
      placeholder.textContent=side==="zh"&&!state.zh ? (state.issue || "尚未生成中文 PDF。完成翻译后会显示在这里。") : "第 "+p.number+" 页";
      shell.append(placeholder);row.append(shell);
    }container.append(row);state.rows.push(row);
  }
  state.observer=new IntersectionObserver(entries=>{
    for(const entry of entries)if(entry.isIntersecting) {
      const n=Number(entry.target.dataset.page);

      queueRender(n);
    }
  },{root:$("viewport"),rootMargin:"300px 0px",threshold:[0,.15,.5]});
  for(const row of state.rows)state.observer.observe(row);
  goPage(current);
  await queueRender(current,token);
}
function queueRender(n,token=generation) {
  state.renderChain=state.renderChain.then(async()=>{
    if(token!==generation||window.closed||state.zoomActive)return;
    const row=state.rows[n-1];if(!row||(row.dataset.rendered==="yes"&&Number(row.dataset.renderScale)===state.scale))return;
    const renderScale=state.scale;
    for(const [i,pdf] of [state.pdf,state.zh].entries()) {
      if(!pdf)continue;
      const shell=row.children[i],page=await pdf.getPage(n);if(token!==generation)return;const vp=page.getViewport({scale:renderScale});
      const canvas=document.createElement("canvas");
      const ratio=Math.min(window.devicePixelRatio||1,2);
      canvas.width=Math.ceil(vp.width*ratio);canvas.height=Math.ceil(vp.height*ratio);
      const task=page.render({canvasContext:canvas.getContext("2d"),viewport:vp,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});
      renderTasks.add(task);try{await task.promise;}finally{renderTasks.delete(task);}
      if(token!==generation)return;
      const layer=document.createElement("div");layer.className="textLayer";layer.style.setProperty("--scale-factor",String(renderScale));
      layer.style.width=vp.width+"px";layer.style.height=vp.height+"px";
      const textLayer=new pdfjs.TextLayer({textContentSource:await page.getTextContent(),container:layer,viewport:vp});
      renderTasks.add(textLayer);try{await textLayer.render();}finally{renderTasks.delete(textLayer);}
      if(token!==generation)return;
      shell.replaceChildren(canvas,layer);shell.dataset.renderScale=renderScale;
      highlight(shell);
    }
    row.dataset.rendered="yes";row.dataset.renderScale=renderScale;if(state.showRegionsOverlay)drawRegionOverlay();drawReadingMarkers();
    if(state.displayPending&&n===Number($("page-number").value)){state.displayPending=false;$("status").textContent=$("status").textContent.replace(" 文件已保存，窗口页面仍在绘制；恢复窗口后继续显示。","");}
    // Keep a bounded number of rendered page pairs in memory.
    const current=Number($("page-number").value);
    for(const other of state.rows)if(Math.abs(Number(other.dataset.page)-current)>5 && other.dataset.rendered==="yes") {
      for(const shell of other.children)shell.replaceChildren();
      delete other.dataset.rendered;
    }
  }).catch(e=>{if(e.name!=="RenderingCancelledException")fail(e);});
  return state.renderChain;
}
function goPage(n) {
  n=Math.max(1,Math.min(state.pages.length,n||1));const row=state.rows[n-1];if(!row)return;
  $("page-number").value=n;$("viewport").scrollTop=row.offsetTop-$("pages").offsetTop;
  queueRender(n);
}
function highlight(shell) {
  const q=$("search-text").value.trim().toLocaleLowerCase(),side=$("search-side").value;
  for(const s of shell.querySelectorAll(".textLayer span"))s.classList.toggle("found",!!q&&shell.dataset.side===side&&s.textContent.toLocaleLowerCase().includes(q));
}
async function search() {
  const q=$("search-text").value.trim().toLocaleLowerCase(),side=$("search-side").value;
  if(!q)return;
  const pdf=side==="zh"?state.zh:state.pdf;
  if(!pdf){status("请先生成中文译版，再搜索中文。");return;}
  const key=side+"|"+q;
  if(state.searchKey!==key) {
    state.searchHits=[];state.searchIndex=-1;state.searchKey=key;
    for(let n=1;n<=pdf.numPages;n++) {
      const p=await pdf.getPage(n),t=await p.getTextContent();
      if(t.items.map(x=>x.str||"").join("").toLocaleLowerCase().includes(q))state.searchHits.push(n);
    }
  }
  if(!state.searchHits.length){$("search-count").textContent="未找到";return;}
  state.searchIndex=(state.searchIndex+1)%state.searchHits.length;
  const n=state.searchHits[state.searchIndex];goPage(n);await state.renderChain;
  for(const shell of document.querySelectorAll(".page-shell"))highlight(shell);
  $("search-count").textContent=(state.searchIndex+1)+" / "+state.searchHits.length+" 个页面";
}
async function generate(options={}) {
  if(state.native&&!options.translator)return generateNative(options);
  if(state.busy)return;
  rebuildStructure();syncLayoutOverrides();
  if(!selected().length)throw new Error("请先选择要翻译的段落。");
  let blocks=[],pending=[],jobs=[];
  const settings=bridge.getSettings(),store=recovery(state.cache);

  bridge.activeSources ||= new Set();
  if(bridge.activeSources.has(state.source.key))throw new Error("这份 PDF 已在另一个窗口生成中，请在那里查看进度。");
  bridge.activeSources.add(state.source.key);state.busy=true;state.controller=new AbortController();
  const signal=state.controller.signal;
  $("generate").disabled=true;$("cancel").hidden=false;$("settings").disabled=true;$("regions").disabled=true;
  let fontBytes;
  try{
    const key=await bridge.getKey();
    for(let pass=0;pass<3;pass++){
      const graph=state.structure;
      if(!(graph&&(graph.candidates.length||graph.uncertainNodes.length)&&settings.structureAssist!==false&&!store.service&&(options.structureFetcher||!options.translator)))break;
      if(!key&&!options.structureFetcher){await showSettings();status("请先填写 API Key，或在结构检查中人工确认。");return;}
      const signature=g=>fingerprint([g.candidates.map(e=>e.id),g.uncertainNodes.map(n=>n.id)]),before=signature(graph);
      const structuralIssues=await assistStructure(graph,state.cache,settings,key,signal,persistCache,status,options.structureFetcher||fetch);
      rebuildStructure();store.issues.push(...structuralIssues);const service=structuralIssues.find(i=>i.service);if(service)store.service=service;
      if(before===signature(state.structure))break;
    }
    blocks=selected();const pendingIDs=new Set(blocks.filter(b=>!translationCurrent(b,state.cache.translations[b.id])).map(b=>b.paragraphID||b.id));
    const scope=options.onlyIDs?new Set(blocks.filter(b=>options.onlyIDs.includes(b.id)).map(b=>b.paragraphID||b.id)):null;
    pending=blocks.filter(b=>pendingIDs.has(b.paragraphID||b.id)&&(!scope||scope.has(b.paragraphID||b.id)));jobs=logicalJobs(pending);
    status("全文预检：检查段落结构和本机字体…");
    clearTranslationIssues(blocks.filter(b=>translationCurrent(b,state.cache.translations[b.id])).map(b=>b.id));
    store.issues=store.issues.filter(i=>i.stage!=="preflight"&&i.stage!=="layout");
    const sourceIssues=[...sourcePreflight(state.pages),...auditSource(state.pages)];store.issues.push(...sourceIssues);
    fontBytes=await bridge.readPDFFonts();
    const fontStamp=fingerprint(await Promise.all([fontBytes.song,fontBytes.times,...(fontBytes.fallbacks||[]).map(f=>f.bytes)].filter(Boolean).map(bytes=>hash(bytes))));
    const blocked=new Set(sourceIssues.flatMap(i=>i.blockIDs));
    const allowedJobs=jobs.filter(j=>!(j.members||[j]).some(b=>blocked.has(b.id))&&canAttempt(store,j));
    const allowed=new Set(allowedJobs.flatMap(j=>(j.members||[j]).map(b=>b.id)));
    const cachedText=Object.fromEntries(blocks.filter(b=>translationCurrent(b,state.cache.translations[b.id])).map(b=>[b.id,state.cache.translations[b.id].text]));
    store.issues.push(...fontPreflight(state.pages,cachedText,fontBytes,window.fontkit));
    if(!pending.length){store.service=null;store.issues=store.issues.filter(i=>!i.service);}
    if(allowed.size&&!key&&!options.translator){await persistCache();await showSettings();status("请先填写 API Key。有效译文及问题记录已保存。");return;}
    await persistCache();state.issue="";state.layoutIssue=null;$("recovery").hidden=true;
    const policy={canAttempt:j=>canAttempt(store,j),repairFor:j=>{
      const draft=state.cache.paragraphDrafts?.[j.id]||state.cache.drafts?.[j.id];return draft?.source===j.text?{previousTranslation:draft.text,validationError:store.issues.filter(i=>i.blockIDs.some(id=>(j.members||[j]).some(b=>b.id===id))).map(i=>i.message).join("；")||draft.error||"请保留完整译义，公式由插件保护。"}:null;
    },onValid:async(values,jobs,drafts)=>{
      for(const job of jobs){
        if(values[job.id]){
          let parts;
          try{parts=splitLogical(job,values[job.id]);}
          catch(_){(state.cache.paragraphDrafts ||= {})[job.id]={source:job.text,text:values[job.id]};continue;}
          for(const b of job.members||[job]){
            if(!(state.cache.translations[b.id]?.manual&&translationCurrent(b,state.cache.translations[b.id])))state.cache.translations[b.id]={source:b.text,text:parts[b.id],paragraphSource:b.paragraphSource,continuous:1};
            delete state.cache.drafts[b.id];clearTranslationIssues([b.id]);
          }
        }
        if(typeof drafts?.[job.id]==="string"){
          if(job.members)(state.cache.paragraphDrafts ||= {})[job.id]={source:job.text,text:drafts[job.id]};
          else state.cache.drafts[job.id]={source:job.text,text:drafts[job.id]};
        }
      }
      await persistCache();
    },beforeRequest:async requested=>{
      aborted(signal);
      if(requested.some(j=>!canAttempt(store,j))){const e=new Error("已达到本段自动尝试上限；请在问题列表主动重新尝试。");e.code="attempt_budget";throw e;}
      for(const j of requested)reserveAttempt(store,j);await persistCache();
    }};
    for(const group of batches(pending.filter(b=>allowed.has(b.id)),3500)){
      if(store.service)break;
      aborted(signal);status("翻译中：已保存 "+blocks.filter(b=>translationCurrent(b,state.cache.translations[b.id])).length+" / "+blocks.length+" 段；单段失败会汇总，不中断其他段落。");
      let result={},error=null;
      try{
        // Custom local translators use the same persistent budget as HTTP translators.
        const translator=options.translator?async(js,...args)=>{await policy.beforeRequest(js);return options.translator(js,...args);}:translate;
        result=await translateLogical(group,settings,key,signal,translator,policy);
      }catch(e){
        aborted(signal);if(e.code==="storage_io")throw e;error=e;result=e.partial||{};
        Object.assign(state.cache.paragraphDrafts ||= {},e.paragraphDrafts||{});
        for(const b of group)if(typeof e.drafts?.[b.id]==="string")state.cache.drafts[b.id]={source:b.text,text:e.drafts[b.id]};
        const issues=(e.issues||[classify(e,group.map(b=>b.id))]).map(i=>({...i,blockIDs:i.blockIDs.length?i.blockIDs:group.map(b=>b.id)}));
        store.issues.push(...issues);
        const service=issues.find(i=>i.service);if(service)store.service=service;
      }
      for(const b of group)if(result[b.id]){
        if(!(state.cache.translations[b.id]?.manual&&translationCurrent(b,state.cache.translations[b.id])))state.cache.translations[b.id]={source:b.text,text:result[b.id],paragraphSource:b.paragraphSource,continuous:1};
        delete state.cache.drafts[b.id];clearTranslationIssues([b.id]);
      }
      for(const j of logicalJobs(group))if((j.members||[j]).every(b=>result[b.id])&&state.cache.paragraphDrafts)delete state.cache.paragraphDrafts[j.id];
      await persistCache();renderIssueBadge();
    }
    const missing=blocks.filter(b=>!translationCurrent(b,state.cache.translations[b.id]));
    const known=new Set(store.issues.flatMap(i=>i.blockIDs));
    for(const b of missing)if(!known.has(b.id))store.issues.push(problem("translation_missing","尚未完成翻译；达到自动尝试上限时需主动重新尝试。",[b.id]));
    // Validate every currently valid translation, even when other paragraphs failed.
    const translations=Object.fromEntries(blocks.filter(b=>translationCurrent(b,state.cache.translations[b.id])).map(b=>[b.id,state.cache.translations[b.id].text]));
    const checkPages=state.pages.map(p=>({...p,blocks:p.blocks.map(b=>({...b,selected:b.selected&&!!translations[b.id]}))}));
    const stamp=layoutStamp(checkPages,translations)+"|"+fontStamp;
    let bytes;state.latestLayout={};
    if(store.layout?.stamp===stamp&&store.layout.issues.length)store.issues.push(...store.layout.issues);
    else{
      try{bytes=await makePDF(checkPages,translations,state.pdf,{PDFLib:window.PDFLib,fontkit:window.fontkit},fontBytes,signal,status,{onLayout:(b,l)=>{(state.latestLayout ||= {})[b.id]={x:l.x,y:l.y,w:l.w||b.w,h:l.h||b.h,size:l.size,leading:l.leading,lines:l.lines.length};}});store.layout={stamp,issues:[]};}
      catch(e){aborted(signal);if(!e.issues)throw e;store.layout={stamp,issues:e.issues};store.issues.push(...e.issues);}
    }
    store.issues=uniqueIssues(currentIssues());state.quality={...qualitySummary(state.pages,translations,state.latestLayout,store.issues),retainedBody:blocksKeptOriginal().length};await persistCache();renderIssueBadge();
    if(store.issues.length){
      try{await showReadingPreview(translations,fontBytes,bytes);}catch(e){if(e.name==="AbortError")throw e;}
      state.issue=issueSummary();throw issuesError(store.issues);
    }
    // Validate the generated document before saving or attaching it.
    const translated=await openPDF(bytes);
    if(translated.numPages!==state.pdf.numPages){await translated.destroy();throw new Error("译版页数不一致，未保存。");}
    let chinese=0;
    for(let n=1;n<=translated.numPages;n++) {
      const p=await translated.getPage(n),v=p.getViewport({scale:1}),expected=state.pages[n-1];
      if(Math.abs(v.width-expected.width)>.1||Math.abs(v.height-expected.height)>.1)throw new Error("译版尺寸不一致，未保存。");
      const t=await p.getTextContent();chinese+=(t.items.map(i=>i.str||"").join("").match(/[\u3400-\u9fff]/g)||[]).length;
    }
    if(!chinese){await translated.destroy();throw new Error("未检测到可搜索的中文文字，未保存译版。");}
    aborted(signal);$("cancel").disabled=true;
    const filename=state.source.key+"-中文-"+new Date().toISOString().replace(/[:.]/g,"-")+".pdf";
    const outputPath=state.paths.root+"\\"+filename;
    await bridge.writePDF(outputPath,bytes);
    state.index={sourceHash:state.source.hash,outputPath,created:new Date().toISOString(),model:settings.model,engine:state.outputEngine,layoutRevision:LAYOUT_REVISION,symbolRevision:SYMBOL_REVISION,pages:translated.numPages,chineseCharacters:chinese,quality:state.quality,completion:blocksKeptOriginal().length?"partial":"complete",keptOriginal:blocksKeptOriginal().length};
    await bridge.writeJSON(state.paths.index,state.index);
    let attachment=null,attachmentError="";
    try{attachment=await bridge.attach(item,outputPath);}catch(e){attachmentError="译版已保存，但关联附件创建失败："+message(e);}
    if(attachment){state.index.attachmentID=attachment.id;await bridge.writeJSON(state.paths.index,state.index);}
    await stopRendering();await state.zh?.destroy();state.zh=translated;state.searchKey=null;state.readingPreview=null;state.savedOutputAvailable=true;
    state.displayPending=await Promise.race([buildRows().then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),8000))]);
    $("open-folder").disabled=false;$("quality").disabled=false;$("generate").textContent="重新生成";
    const retainedBody=blocksKeptOriginal().length;
    const coverageNotice=retainedBody?" 另有 "+retainedBody+" 段正文保留原文，可在“检查段落”中重新勾选。":"";
    status((attachmentError || "已保存 "+translated.numPages+" 页"+(retainedBody?"待完成译版":"中文 PDF")+"，可搜索、复制。"+(attachment?"已添加到当前文献附件。":"文件已保存；当前文库不支持链接附件。"))+coverageNotice+(state.displayPending?" 文件已保存，窗口页面仍在绘制；恢复窗口后继续显示。":""),!!attachmentError||!!retainedBody);
    return state.index;
  }catch(e){
    if(e.name==="AbortError"||e.code==="storage_io")throw e;
    const store=recovery(state.cache);
    if(!e.issues)store.issues.push(classify(e,blocks.map(b=>b.id)));
    await persistCache();renderIssueBadge();
    if(e.issues){status(issueSummary(),true);throw e;}throw e;
  }finally {
    bridge.activeSources.delete(state.source.key);
    state.busy=false;state.controller=null;
    renderIssueBadge();drawRegionOverlay();
    $("generate").disabled=!selected().length;$("cancel").hidden=true;$("cancel").disabled=false;$("settings").disabled=false;$("regions").disabled=false;
  }
}
function syncLayoutOverrides(){
  state.cache.layoutOverrides ||= {};
  for(const b of state.pages.flatMap(p=>p.blocks)){
    const v=state.cache.layoutOverrides[b.id];if(v?.source===b.text)b.layoutOverride=v;else delete b.layoutOverride;
  }
}
async function previewDraft(b,draft){
  if(draft.scope!=="paragraph")return previewParagraph(b.id,draft.text);
  // A failed logical draft cannot be assigned to a page until formula/science
  // validation succeeds. Show the actual full source and draft immediately.
  state.previewClose?.();state.previewClose=null;
  $("preview-title").textContent="完整续段 · "+draft.job.members.map(x=>"第 "+x.page+" 页").filter((v,i,a)=>a.indexOf(v)===i).join("、");
  document.querySelector(".preview-controls").hidden=true;
  document.querySelector(".preview-pages").hidden=true;$("preview-texts").hidden=false;
  $("preview-full-source").textContent=visibleSymbols(draft.source);
  $("preview-full-draft").textContent=visibleSymbols(draft.text);
  let cause=draft.entry.error||"";
  try{splitLogical(draft.job,draft.text);}catch(e){cause=message(e);}
  $("preview-feedback").textContent="已找回完整段落草稿；下方包含所有续接片段，并非缺失译文。"+(cause?"尚未通过："+cause:"可返回问题列表，一键复核并采用。")+" 未安全分配到各页前不能应用排版，无需调整字号。";
  $("preview-apply").disabled=true;$("preview-apply").onclick=null;
  if(!$("preview-dialog").open)$("preview-dialog").showModal();
}
async function previewParagraph(id,text){
  if(state.busy)return;
  document.querySelector(".preview-controls").hidden=false;document.querySelector(".preview-pages").hidden=false;$("preview-texts").hidden=true;
  const b=state.pages.flatMap(p=>p.blocks).find(b=>b.id===id);if(!b)return;
  const p=state.pages.find(p=>p.number===b.page),validation=validationIssuesFor(b,text);
  // Only scientific-value diagnostics may bypass that check for a marked,
  // in-memory proposal. Formula ownership and encoding checks remain strict.
  const valid=validation.length?validateParagraph(b,text,{scientific:false}):validateParagraph(b,text);
  state.previewController?.abort();state.previewSession=(state.previewSession||0)+1;
  const session=state.previewSession;let sequence=0,timer=null,successful=null;
  state.previewClose=()=>{clearTimeout(timer);state.previewController?.abort();state.previewSession++;};
  $("preview-dialog").oncancel=()=>state.previewClose();
  $("preview-title").textContent="第 "+b.page+" 页 · "+b.id+" · 局部排版预览";
  $("preview-size").value=b.layoutOverride?.fontSize||"";$("preview-leading").value=b.layoutOverride?.leading||"";
  $("preview-apply").disabled=true;
  if(!$("preview-dialog").open)$("preview-dialog").showModal();
  const flow=p.structure?.flows.find(f=>f.id===b.flowID),area=flow||b;
  const crop={x:Math.max(0,area.x-18),y:Math.max(0,area.y-24),w:Math.min(p.width-Math.max(0,area.x-18),area.w+36),h:Math.min(p.height-Math.max(0,area.y-24),Math.max(140,area.h+60))};
  let previewRect=b;
  const draw=async(pdf,number,target,mark)=>{
    const page=await pdf.getPage(number),scale=1.6,canvas=document.createElement("canvas"),vp=page.getViewport({scale});canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
    const task=page.render({canvasContext:canvas.getContext("2d"),viewport:vp});await task.promise;
    if(session!==state.previewSession){canvas.width=canvas.height=0;return;}
    target.width=Math.ceil(crop.w*scale);target.height=Math.ceil(crop.h*scale);const ctx=target.getContext("2d");ctx.drawImage(canvas,crop.x*scale,crop.y*scale,crop.w*scale,crop.h*scale,0,0,target.width,target.height);
    ctx.strokeStyle=mark;ctx.lineWidth=2;const r=pdf===state.pdf?b:previewRect;ctx.strokeRect((r.x-crop.x)*scale,(r.y-crop.y)*scale,r.w*scale,r.h*scale);canvas.width=canvas.height=0;
  };
  await draw(state.pdf,p.number,$("preview-source"),"#215c9d");
  const render=async()=>{
    clearTimeout(timer);const turn=++sequence;state.previewController?.abort();const controller=new AbortController();state.previewController=controller;successful=null;$("preview-apply").disabled=true;$("preview-feedback").textContent="正在本机预排版，不调用翻译 API…";
    let temp=null,diagnostic=null;
    try{
      if(!$("preview-size").validity.valid||!$("preview-leading").validity.valid)throw new Error("字号须为5.5至24pt，行距须为1.05至2倍。");
      const override={source:b.text,fontSize:Number($("preview-size").value)||null,leading:Number($("preview-leading").value)||null};
      const texts={[id]:valid};for(const x of p.blocks)if(x.selected&&flow&&x.flowID===flow.id&&translationCurrent(x,state.cache.translations[x.id]))texts[x.id]=state.cache.translations[x.id].text;texts[id]=valid;
      const page={...p,blocks:p.blocks.map(x=>({...x,selected:!!texts[x.id],layoutOverride:x.id===id?override:x.layoutOverride}))};
      state.previewFonts ||= await bridge.readPDFFonts();let measured=null;
      const bytes=await makePDF([page],texts,state.pdf,{PDFLib:window.PDFLib,fontkit:window.fontkit},state.previewFonts,controller.signal,()=>{},{partial:true,diagnosticIssues:validation,onDiagnostic:d=>{diagnostic=d;state.previewDiagnostic={page:d.page,issues:d.issues,placed:d.layouts.map(l=>l.id),chineseText:texts[id]};},onLayout:(target,l)=>{if(target.id===id){measured={size:l.size,leading:l.leading,lines:l.lines.length};previewRect={x:l.x,y:l.y,w:l.w||b.w,h:l.h||b.h};}}});
      if(turn!==sequence||session!==state.previewSession)return;
      temp=await openPDF(bytes);await draw(temp,1,$("preview-result"),"#23804a");
      if(turn!==sequence||session!==state.previewSession)return;
      successful=override;$("preview-apply").disabled=false;$("preview-feedback").textContent="可以安全放入："+measured.size.toFixed(2)+"pt，行距 "+(measured.leading/measured.size).toFixed(2)+" 倍，共 "+measured.lines+" 行。同栏已有有效译文共同参与排版，其他区域保留原文；生成时仍会检查整页。";
    }catch(e){
      if(controller.signal.aborted||turn!==sequence||session!==state.previewSession)return;
      if(diagnostic){
        temp=await openPDF(diagnostic.bytes);await draw(temp,diagnostic.index,$("preview-result"),"#b1372d");
        const ctx=$("preview-result").getContext("2d");ctx.fillStyle="#b1372d22";ctx.strokeStyle="#b1372d";
        for(const issue of diagnostic.issues)for(const r of [issue.geometry?.text,issue.geometry?.obstacle].filter(Boolean)){
          ctx.fillRect((r.x-crop.x)*1.6,(r.y-crop.y)*1.6,r.w*1.6,r.h*1.6);ctx.strokeRect((r.x-crop.x)*1.6,(r.y-crop.y)*1.6,r.w*1.6,r.h*1.6);
        }
      }else{const canvas=$("preview-result");canvas.width=600;canvas.height=160;const ctx=canvas.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,600,160);ctx.fillStyle="#9b312a";ctx.font="16px sans-serif";ctx.fillText("无法生成中文诊断图，请先处理下方原因。",20,70);}
      $("preview-feedback").textContent=previewFailureMessage(e.issues||validation.length&&validation||[classify(e,[id])],!!diagnostic);
    }finally{await temp?.destroy();}
  };
  const schedule=()=>{clearTimeout(timer);successful=null;$("preview-apply").disabled=true;$("preview-feedback").textContent="正在重新预览…";sequence++;state.previewController?.abort();timer=setTimeout(()=>render().catch(fail),180);};
  $("preview-size").oninput=schedule;$("preview-leading").oninput=schedule;
  $("preview-auto").onclick=()=>{$("preview-size").value="";$("preview-leading").value="";render().catch(fail);};
  $("preview-apply").onclick=async()=>{
    if(!successful)return;
    try{
    state.cache.layoutOverrides[id]=successful;state.cache.translations[id]={source:b.text,text:valid,paragraphSource:b.paragraphSource,manual:true};
    delete state.cache.drafts[id];clearTranslationIssues([id]);syncLayoutOverrides();recovery(state.cache).layout=null;
    await persistCache();renderIssueBadge();$("preview-dialog").close();renderRegions();status("已保存 "+id+" 的译文和局部排版设置。继续生成时会检查整篇，不需要重新翻译。");
    }catch(e){$("preview-feedback").textContent=message(e);}
  };
  await render();
}
function blocksKeptOriginal(){return state.pages.flatMap(p=>p.blocks).filter(b=>!b.selected&&!locked(b)&&!scientificLabel(b.text)&&((["正文","标题","图表标题"].includes(b.kind)&&!b.reason)||state.cache.selectionOverrides[b.id]?.origin==="issue-recovery"));}

function nativeControls(){
 $("generate").disabled=!!state.busy;$("settings").disabled=!!state.busy;$("issues").disabled=!state.source;
 $("regions").disabled=!!state.busy||!state.nativeRegions?.length;
 for(const id of ["structure","region-overlay"]){$(id).disabled=true;$(id).title="本机引擎直接识别原始 PDF；区域可在检查段落中查看。";}
 $("cancel").hidden=!state.busy;$("cancel").disabled=false;
}
function nativeProgress(e){const stages={"Parse PDF and Create Intermediate Representation":"解析原始 PDF","DetectScannedFile":"检查文本层","Parse Page Layout":"识别正文、图表和版权区域","Parse Paragraphs":"重建段落","Parse Formulas and Styles":"保护公式与样式","Translate Paragraphs":"翻译并保存断点","Typesetting":"排版译文","Add Fonts":"嵌入本机字体","Generate drawing instructions":"生成绘制指令","Subset font":"精简字体","Save PDF":"保存译版"};status(e.message||(stages[e.stage]||"处理 PDF")+" · "+Math.round(e.percent||0)+"%");}
async function generateNative(options={}){
 if(state.busy)return;
 if(!(await bridge.engine.status(bridge)).ready){await showSettings();status("请先点击设置中的“安装／修复本机引擎”。");return;}
 if(!await bridge.getKey()){await showSettings();status("请先填写 DeepSeek API Key。");return;}
 bridge.activeSources ||= new Set();if(bridge.activeSources.has(state.source.key))throw new Error("这篇论文正在另一个窗口生成。");
 bridge.activeSources.add(state.source.key);state.busy=true;state.controller=new AbortController();state.nativeError="";nativeControls();
 try{
  const result=await bridge.engine.generate(bridge,state.source,state.paths,{signal:state.controller.signal,onProgress:nativeProgress,retry:!!options.retry,pages:options.pages});
  aborted(state.controller.signal);
  const bytes=await IOUtils.read(result.output),pdf=await openPDF(bytes);let chinese=0;
  try{if(pdf.numPages!==state.pdf.numPages)throw new Error("译版页数不一致，未保存。");for(let n=1;n<=pdf.numPages;n++){const p=await pdf.getPage(n),v=p.getViewport({scale:1}),expected=state.pages[n-1];if(Math.abs(v.width-expected.width)>.1||Math.abs(v.height-expected.height)>.1)throw new Error("译版尺寸不一致，未保存。");const t=await p.getTextContent();chinese+=(t.items.map(x=>x.str||"").join("").match(/[\u3400-\u9fff]/g)||[]).length;}if(!chinese)throw new Error("译版未包含可搜索中文，未保存。");}catch(e){await pdf.destroy();throw e;}
  aborted(state.controller.signal);$("cancel").disabled=true;
  const outputPath=PathUtils.join(state.paths.root,state.source.key+"-中文-本机-"+new Date().toISOString().replace(/[:.]/g,"-")+".pdf");await bridge.writePDF(outputPath,bytes);
  const index={sourceHash:state.source.hash,outputPath,created:new Date().toISOString(),engine:bridge.engine.version,model:bridge.getSettings().model,pages:pdf.numPages,chineseCharacters:chinese,completion:result.keptOriginal?"partial":"complete",keptOriginal:result.keptOriginal||0,regionsPath:result.regions,nativeCachePath:result.cache,requests:result.requests,quality:{backend:"babeldoc",checks:["页数","尺寸","可搜索中文","原件哈希"],limits:"几何与译义仍需阅读复核。"}};
  await bridge.writeJSON(state.paths.index,index);await bridge.writeJSON(PathUtils.join(state.paths.dir,state.source.key+"-native-issues.json"),{sourceHash:state.source.hash,error:null});state.index=index;let warning="";
  try{const a=await bridge.attach(item,outputPath);if(a){index.attachmentID=a.id;await bridge.writeJSON(state.paths.index,index);}}catch(e){warning="文件已保存，关联附件失败，可再次打开文件重试。";}
  state.nativeRegions=await bridge.json(result.regions)||[];state.nativeRegionsPath=result.regions;state.nativeCachePath=result.cache;await state.zh?.destroy();state.zh=pdf;state.searchKey=null;
  state.displayPending=await Promise.race([buildRows().then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),8000))]);$("open-folder").disabled=false;$("generate").textContent="重新生成";
  status(warning||"已保存 "+pdf.numPages+" 页中文 PDF，可搜索、复制。再次生成会复用本机引擎缓存。"+(result.keptOriginal?" 另有 "+result.keptOriginal+" 段按选择保留原文，当前为待完成译版。":""),!!warning||!!result.keptOriginal);return index;
 }catch(e){state.nativeError=message(e);if(e.nativeRegionsPath){state.nativeRegionsPath=e.nativeRegionsPath;state.nativeCachePath=e.nativeCachePath;try{state.nativeRegions=await bridge.json(e.nativeRegionsPath)||state.nativeRegions;}catch(_){}}await bridge.writeJSON(PathUtils.join(state.paths.dir,state.source.key+"-native-issues.json"),{sourceHash:state.source.hash,error:state.nativeError,regionsPath:state.nativeRegionsPath||null,cachePath:state.nativeCachePath||null});status(state.nativeError,true);throw e;}
 finally{bridge.activeSources.delete(state.source.key);state.busy=false;state.controller=null;nativeControls();}
}
function renderNativeRegions(){
 const page=Math.max(1,Math.min(state.pages.length,Number($("region-page").value)||1));$("region-page").value=page;
 const list=$("region-list");list.replaceChildren();$("region-issue").hidden=false;$("region-issue").textContent="本机引擎识别区域。参考文献、图表及版权信息保留原文；修改译文后再次生成可复用缓存。";
 for(const r of (state.nativeRegions||[]).filter(r=>r.page===page)){
  const el=document.createElement("section");el.className="region";const title=document.createElement("strong");title.textContent=r.id+" · "+(r.preserve?"保留原文":r.role);
  const source=document.createElement("p");source.textContent=r.source;
  const choose=document.createElement("input");choose.type="checkbox";choose.checked=!r.preserve;choose.disabled=!!r.hardProtected;
  choose.onchange=async()=>{try{const path=state.nativeCachePath||state.index?.nativeCachePath,cache=await bridge.json(path);cache.selectionOverrides ||= {};cache.selectionOverrides[r.sourceStamp]=!choose.checked;await bridge.writeJSON(path,cache);r.preserve=!choose.checked;await bridge.writeJSON(state.nativeRegionsPath||state.index.regionsPath,state.nativeRegions);}catch(e){choose.checked=!choose.checked;status(message(e),true);}};
  el.append(choose,title,source);if(r.error){const issue=document.createElement("p");issue.textContent=r.error;issue.className="region-issue";el.append(issue);}
  if(!r.preserve&&r.cacheKey&&r.rawSource){const area=document.createElement("textarea");area.value=r.rawTranslation||r.draft||r.text;const save=document.createElement("button");save.textContent="保存这段修改";const feedback=document.createElement("p");save.onclick=async()=>{try{const tokens=t=>(t.match(/<\/?b\d+>|\{v\d+\}/g)||[]).sort().join("|");if(tokens(area.value)!==tokens(r.rawSource))throw new Error("请完整保留公式标记。");const cachePath=state.nativeCachePath||state.index?.nativeCachePath,cache=await bridge.json(cachePath),entry=cache?.translations[r.cacheKey];if(entry&&entry.source!==r.rawSource)throw new Error("原文上下文已变化，请重新生成后修改。");cache.translations[r.cacheKey]={...(entry||{}),source:r.rawSource,text:area.value,manual:true};await bridge.writeJSON(cachePath,cache);r.rawTranslation=area.value;await bridge.writeJSON(state.nativeRegionsPath||state.index.regionsPath,state.nativeRegions);feedback.textContent="修改已保存，再次生成应用到 PDF；已完成段落不会重复请求。";}catch(e){feedback.textContent=message(e);}};const preview=document.createElement("button");preview.textContent="排版调整与预览";preview.onclick=()=>previewNative(r,area.value).catch(fail);el.append(area,save,preview,feedback);}
  list.append(el);
 }
}

async function previewNative(region,text){
 if(state.busy)return;
 const dialog=$("preview-dialog");$("preview-title").textContent=region.id+" · 排版预览";$("preview-feedback").textContent="修改字号或行距后点击预览；不会调用 DeepSeek。";
 $("preview-size").value=region.layout?.size||"";$("preview-leading").value=region.layout?.leading||"";$("preview-apply").disabled=true;
 const cachePath=state.nativeCachePath||state.index?.nativeCachePath,originalCache=await bridge.json(cachePath),entry=originalCache?.translations[region.cacheKey];
 if(!entry)throw new Error("请先保存这段译文，再进行排版预览。");
 let validOverride=null,timer=null,sequence=0;
 const draw=async(pdf,n,canvas)=>{const p=await pdf.getPage(n),v=p.getViewport({scale:.85});canvas.width=Math.ceil(v.width);canvas.height=Math.ceil(v.height);await p.render({canvasContext:canvas.getContext("2d"),viewport:v}).promise;};
 const render=async()=>{
  const current=++sequence;state.previewController?.abort();const controller=new AbortController();state.previewController=controller;validOverride=null;$("preview-apply").disabled=true;
  const size=Number($("preview-size").value)||null,leading=Number($("preview-leading").value)||null;
  if(size&&(size<5.5||size>24)||leading&&(leading<1.05||leading>2)){ $("preview-feedback").textContent="字号须为5.5—24pt，行距须为1.05—2倍。";return;}
  $("preview-feedback").textContent="正在用已保存译文生成预览，不调用翻译服务…";
  let pdf;
  try{
   const override={key:region.cacheKey,source:region.rawSource,text,layout:{size,leading}},result=await bridge.engine.generate(bridge,state.source,state.paths,{action:"preview",signal:controller.signal,overrides:[override],onProgress:e=>{if(current===sequence)$("preview-feedback").textContent=e.message||"本地排版预览 · "+Math.round(e.percent||0)+"%";}});
   if(current!==sequence)return;pdf=await openPDF(await IOUtils.read(result.output));await draw(pdf,region.page,$("preview-result"));validOverride=override;$("preview-apply").disabled=false;$("preview-feedback").textContent="预览已生成。引擎会在安全区域内自动拟合；请核对实际字号、公式和相邻区域后应用。";
  }catch(e){if(current===sequence&&!controller.signal.aborted)$("preview-feedback").textContent=message(e);}finally{await pdf?.destroy();}
 };
 const schedule=()=>{clearTimeout(timer);state.previewController?.abort();timer=setTimeout(()=>render().catch(fail),550);};
 $("preview-size").oninput=schedule;$("preview-leading").oninput=schedule;$("preview-auto").onclick=()=>{$("preview-size").value="";$("preview-leading").value="";render().catch(fail);};
 state.previewClose=()=>{sequence++;clearTimeout(timer);state.previewController?.abort();};
 $("preview-apply").onclick=async()=>{if(!validOverride)return;const cache=await bridge.json(cachePath);if(cache.translations[region.cacheKey]?.source!==region.rawSource)throw new Error("原文已变化，请重新打开预览。");cache.translations[region.cacheKey]={...entry,text:validOverride.text,layout:validOverride.layout,manual:true};await bridge.writeJSON(cachePath,cache);region.layout=validOverride.layout;region.rawTranslation=validOverride.text;await bridge.writeJSON(state.nativeRegionsPath||state.index.regionsPath,state.nativeRegions);state.previewClose();dialog.close();status("已保存译文与排版设置，再次生成应用到整篇 PDF。");};
 if(!dialog.open)dialog.showModal();await draw(state.pdf,region.page,$("preview-source"));await render();
}
window.ZBPApp.ready=initialize();
window.ZBPApp.ready.catch(fail);
