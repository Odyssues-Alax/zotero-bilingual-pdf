import {containsEmail} from "./source-text.mjs";
import {adaptSymbolTranslation,SYMBOL_REVISION,auditScientificDocument} from "./symbols.mjs";
import {buildStructure} from "./structure.mjs";
import {literal,referenceTitle,tableReferenceTitle,referenceMarkers} from "./references.mjs";
// Document semantics are separate from physical PDF boxes.
import {isCaption,validateParagraph} from "./core.mjs";
export const LAYOUT_REVISION=26;
const refs=text=>/^(?:\d+\.?\s+)?(?:references|bibliography)\s*$/i.test(text);
export const locked=b=>b.protectedFormula || b.reason==="跨栏文本" || /^参考文献/.test(b.reason);
const captionBlock=b=>(!b.inlineFigureReference&&isCaption(b.text))||b.kind==="图表标题"||((b.lines||[]).length>1&&/^(?:Fig(?:ure)?\.?|Table)\s*S?\s*\d+[A-Za-z]?\s*$/i.test(b.lines[0].text?.trim()||""));
const body=b=>b.selected && b.kind==="正文" && !containsEmail(b.text);
const continuation=(a,b)=>{
  const tail=a.text.replace(/⟦M\d+⟧/g," ").trim();
  const head=b.text.replace(/⟦M\d+⟧/g," ").trim();
  return !/[.!?。！？:;][)\]”'\s]*$/.test(tail) && (/^[a-z(]/.test(head) || (/^[A-Z]/.test(head) && (b.lines?.[0]?.x??b.x)-b.x<b.fs*.8)) && Math.abs(a.fs-b.fs)<Math.max(.5,a.fs*.12);
};
export function finalizeDocument(pages,decisions){
  for(const p of pages)for(const b of p.blocks){
    b.initialClassification ||= b.baseClassification||{selected:b.selected,reason:b.reason,kind:b.kind};
    Object.assign(b,b.initialClassification);delete b.paragraphContext;delete b.paragraphSource;delete b.flowID;
  }
  let inReferences=false;
  for(const page of pages){
    const blocks=page.blocks;
    const hasCaption=blocks.some(captionBlock);
    const citationCount=blocks.filter(b=>/^\[\d+\]|^\d+[.)]\s+[A-Z]/.test(literal(b))).length;
    const newSection=blocks.some(b=>b.y<page.height*.25 && /^(?:electronic\s+supplementary\s+material|table\s+of\s+contents|(?:\d+(?:\.\d+)*\.?\s+)?(?:methods|materials|results|discussion|conclusions?|appendix|supplement|supporting information|acknowledg))\b/i.test(b.text));
    if(newSection || (hasCaption && citationCount<2))inReferences=false;
    // Some publishers omit the References heading. Require multiple numbered
    // author entries, then protect their continuation blocks in each column.
    const entries=referenceMarkers(blocks);
    const headings=blocks.filter(b=>referenceTitle(literal(b))&&!tableReferenceTitle(b,blocks,page.width));
    const refHeading=headings.sort((a,b)=>(a.x<page.width/2?0:1)-(b.x<page.width/2?0:1)||a.y-b.y)[0];
    const inferred=entries.length>=3?entries.sort((a,b)=>(a.x<page.width/2?0:1)-(b.x<page.width/2?0:1)||a.y-b.y)[0]:null;
    const refStart=refHeading||inferred;
    page.referenceEvidence={heading:refHeading?.id||null,numberedEntries:entries.length,start:refStart?{x:refStart.x,y:refStart.y}:null,ignoredTableHeadings:blocks.filter(b=>tableReferenceTitle(b,blocks,page.width)).map(b=>b.id)};
    for(const b of blocks){
      b.page=page.number;
      if(refStart){const c=b.x<page.width/2?0:1,h=refStart.x<page.width/2?0:1;if(c>h||(c===h&&b.y>=refStart.y-1)){b.selected=false;b.reason="参考文献标题后的条目及续行";}}
      if(tableReferenceTitle(b,blocks,page.width)){b.selected=false;b.reason="表格列标题";}
      if(inReferences && !captionBlock(b)){b.selected=false;b.reason="参考文献续页";}
      if(captionBlock(b) && /^参考文献/.test(b.reason)){b.reason="";b.selected=true;}
      if(locked(b))b.selected=false;
    }
    if(refStart)inReferences=true;
  }
  for(const p of pages)for(const b of p.blocks){const override=decisions?.selectionOverrides?.[b.id];if(override?.source===b.text&&!locked(b))b.selected=override.selected;}
  pages.structure=buildStructure(pages,decisions);
  return pages;
}
export function translationCurrent(b,value){
  if(!value || value.source!==b.text)return false;
  if(!value.manual&&((value.paragraphSource||null)!==(b.paragraphSource||null)||(b.paragraphSource&&value.continuous!==1)))return false;
  try{validateParagraph(b,value.text);return true;}catch(_){return false;}
}
export function migrateCache(pages,cache){
  // Upgrade only source-matching entries. Keep exact originals for recovery.
  const blocks=pages.flatMap(p=>p.blocks),changes=blocks.filter(b=>b.symbolOriginal&&b.symbolOriginal.text!==b.text);
  const contexts=value=>{if(typeof value!=="string")return value;for(const b of changes){value=value.split(b.symbolOriginal.text).join(b.text);if(b.symbolPrevious?.text!==b.text)value=value.split(b.symbolPrevious.text).join(b.text);}return value;};
  for(const b of blocks){
    const sources=[b.text,b.symbolOriginal?.text,b.symbolPrevious?.text].filter(Boolean);
    for(const collection of ["translations","drafts","selectionOverrides","layoutOverrides"]){
      for(const [id,entry] of Object.entries(cache[collection]||{})){
        if(!id.startsWith("p"+b.page+"b")||!entry||!sources.includes(entry.source))continue;
        const changed=entry.source!==b.text,needsCheck=entry.symbolRevision!==SYMBOL_REVISION;
        if(!changed&&!needsCheck)continue;
        const upgraded={...entry,source:b.text,paragraphSource:contexts(entry.paragraphSource),symbolRevision:SYMBOL_REVISION};
        if(changed&&typeof entry.text==="string")upgraded.text=adaptSymbolTranslation(entry.text,entry.source,b);
        if(collection==="translations"&&typeof upgraded.text==="string")try{validateParagraph(b,upgraded.text);}catch(e){upgraded.error=e.message;upgraded.invalid=true;}
        if(collection==="translations"&&(upgraded.text===null||upgraded.invalid)){
          cache.symbolBackups ||= {};cache.symbolBackups[collection+"|"+id+"|"+(entry.symbolRevision||"legacy")] ||= entry;
          cache.drafts ||= {};cache.drafts[id]={...upgraded,text:upgraded.text??entry.text,error:upgraded.error||"原符号未完整保留，需要核对或补译。"};delete cache.translations[id];continue;
        }
        if(changed){cache.symbolBackups ||= {};cache.symbolBackups[collection+"|"+id+"|"+(entry.symbolRevision||"legacy")] ||= entry;}
        cache[collection][id]=upgraded;
      }
    }
  }
  cache.symbolRevision=SYMBOL_REVISION;
  const index=(entries,getSource)=>{
    const map=new Map();
    for(const [id,value] of Object.entries(entries||{})){
      const page=id.match(/^p\d+/)?.[0],source=getSource(value);
      if(page&&typeof source==="string"){const key=page+"|"+source;map.set(key,map.has(key)?null:{id,value});}
    }
    return map;
  };
  const translated=index(cache.translations,v=>v?.source),drafts=index(cache.drafts,v=>v?.source);
  const overrides=index(cache.selectionOverrides,v=>v?.source),layouts=index(cache.layoutOverrides,v=>v?.source);
  const output={translations:{},drafts:{},selection:{},selectionSources:{},selectionOverrides:{},layoutOverrides:{}};
  for(const page of pages)for(const b of page.blocks){
    const key="p"+page.number+"|"+b.text,t=translated.get(key),d=drafts.get(key),o=overrides.get(key);
    if(t)output.translations[b.id]=t.value;
    const layout=layouts.get(key);if(layout)output.layoutOverrides[b.id]=layout.value;
    if(d)output.drafts[b.id]=d.value;
    // A temporary layout workaround is retried after a layout revision.
    // Explicit manual exclusions remain untouched.
    const retry=o?.value.origin==="layout-recovery" && cache.layoutRevision!==LAYOUT_REVISION && !locked(b);
    if(o&&!retry){output.selectionOverrides[b.id]=o.value;b.selected=o.value.selected;}
    if(locked(b))b.selected=false;
    output.selection[b.id]=b.selected;output.selectionSources[b.id]=b.text;
  }
  Object.assign(cache,output,{layoutRevision:LAYOUT_REVISION});
  const integrity=auditScientificDocument(pages,Object.fromEntries(Object.entries(cache.translations).map(([id,t])=>[id,t.text])));
  for(const issue of integrity)for(const id of issue.blockIDs){
    const entry=cache.translations[id];if(!entry)continue;
    cache.symbolBackups ||= {};cache.symbolBackups["translations|"+id+"|"+(entry.symbolRevision||"legacy")] ||= entry;
    cache.drafts[id]={...entry,error:issue.message};delete cache.translations[id];
  }
  cache.symbolAudit={revision:SYMBOL_REVISION,issues:integrity};
  return cache;
}
