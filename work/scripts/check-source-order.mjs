
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import * as pdfjs from "../addon/content/vendor/pdf.mjs";
import * as worker from "../addon/content/vendor/pdf.worker.mjs";
import {segmentWithModel,modelObstacles} from "../addon/content/model-layout.mjs";
import {finalizeDocument} from "../addon/content/document.mjs";
import {readSourceTags,applySourceTags} from "../addon/content/pdf-structure.mjs";
import {logicalJobs} from "../addon/content/flow.mjs";
import {literal} from "../addon/content/references.mjs";
import {auditSource} from "../addon/content/quality.mjs";

globalThis.pdfjsWorker=worker;
const [fixturesPath,storage,cacheDir]=process.argv.slice(2);
if(!fixturesPath||!storage||!cacheDir)throw Error("Usage: node work/scripts/check-source-order.mjs <fixtures.json> <Zotero storage> <model cache>");
const fixtures=JSON.parse(await fs.readFile(fixturesPath,"utf8"));
assert(fixtures.length,"No reference samples");
const normalize=text=>text.normalize("NFKC").toLowerCase().replace(/[\s\u0002\u00ad]/gu,"").replace(/[\u2010\u2011]/gu,"-");
const hashes=bytes=>createHash("sha256").update(bytes).digest("hex");

function findBlock(pages,anchor){
 const needle=normalize(anchor.contains);
 const matches=(pages.find(p=>p.number===anchor.page)?.blocks||[]).filter(b=>normalize(literal(b)).includes(needle));
 assert.equal(matches.length,1, "Source anchor missing or duplicated on page "+anchor.page+": "+anchor.contains);
 return matches[0];
}
function checkCase(pages,test){
 if(test.kind==="distinct"){
  const blocks=test.anchors.map(a=>findBlock(pages,a));
  assert(blocks.every(b=>b.selected),"Expected translated body");
  assert.equal(new Set(blocks.map(b=>b.paragraphID)).size,blocks.length,"Independent paragraphs were joined");
  return;
 }
 if(test.kind==="retained"){
  const b=findBlock(pages,test.anchor);
  assert.equal(b.role,test.role,"Incorrect retained role");
  assert.equal(b.selected,false,"Protected text entered translation");
  return;
 }
 const anchor=findBlock(pages,test.anchor);
 assert(anchor.selected,"Expected source was excluded from translation");
 assert.equal(anchor.role,test.role,"Incorrect source role");
 const jobs=logicalJobs(pages.flatMap(p=>p.blocks.filter(b=>b.selected)));
 const job=jobs.find(j=>(j.members||[j]).some(b=>b.id===anchor.id));
 assert(job,"Missing translation job");
 const content=normalize(literal(job));
 let cursor=0;
 for(const phrase of test.ordered){
  const wanted=normalize(phrase),at=content.indexOf(wanted,cursor);
  assert(at>=0,"Expected text missing or out of order: "+phrase);
  cursor=at+wanted.length;
 }
 if(test.exact)assert.equal(content,normalize(test.exact),"Text coverage differs from independent extract");
 if(test.exclude)for(const phrase of test.exclude)assert(!content.includes(normalize(phrase)),"Unrelated text entered translation: "+phrase);
 if(test.endpoints)for(const point of test.endpoints){
  const b=findBlock(pages,point);
  assert((job.members||[job]).some(m=>m.id===b.id),"Continuation was not included in the same job");
 }
}

let checks=0,pagesChecked=0,injections=0;
for(const fixture of fixtures){
 const sourceDir=path.join(storage,fixture.key);
 const candidates=(await fs.readdir(sourceDir)).filter(n=>n.toLowerCase().endsWith(".pdf"));
 const matching=[];
 for(const file of candidates){
  const bytes=await fs.readFile(path.join(sourceDir,file));
  if(hashes(bytes)===fixture.sha256)matching.push(bytes);
 }
 assert.equal(matching.length,1,fixture.key+": expected exactly one matching original PDF");
 const modelPath=path.join(cacheDir,"1-"+fixture.key+"-"+fixture.sha256.slice(0,12)+"-model-layout1.json");
 const modelBytes=await fs.readFile(modelPath);
 assert.equal(hashes(modelBytes),fixture.layoutSha256,"Reference model cache changed");
 const model=JSON.parse(modelBytes);
 assert.equal(model.sourceHash,fixture.sha256,"Cached model is for a different PDF");
 const pdf=await pdfjs.getDocument({data:new Uint8Array(matching[0]),isEvalSupported:false,useSystemFonts:true}).promise;
 try{
  assert.equal(model.pages.length,pdf.numPages);
  const pages=[];
  for(let number=1;number<=pdf.numPages;number++){
   const page=await pdf.getPage(number),v=page.getViewport({scale:1}),text=await page.getTextContent(),m=model.pages[number-1];
   const blocks=segmentWithModel(text,v,pdfjs,number,m);
   applySourceTags(blocks,await readSourceTags(page,text));
   pages.push({number,width:v.width,height:v.height,blocks,visualRegions:modelObstacles(m)});
  }
  finalizeDocument(pages,{});
  assert.deepEqual(auditSource(pages),[],fixture.key+": unexpected source issue");
  pagesChecked+=pages.length;
  for(const test of fixture.cases){
   try{checkCase(pages,test);}catch(error){throw Error(test.name+": "+error.message,{cause:error});}
   checks++;
  }
  const test=fixture.cases.find(test=>test.inject);
  if(test){
   // Retain all original glyph ownership while corrupting the input to translation.
   const target=findBlock(pages,test.anchor);
   const previous={text:target.text,selected:target.selected,readingIndex:target.readingIndex};
   if(test.inject==="omit"){
    target.text=target.text.replace(test.ordered.at(-1),"");
    assert.notEqual(target.text,previous.text);
   }else if(test.inject==="reverse"){
    const endpoint=findBlock(pages,test.endpoints[0]);
    target.readingIndex=endpoint.readingIndex+1;
   }else if(test.inject==="exclude")target.selected=false;
   else throw Error("Unknown injected fault");
   assert.throws(()=>checkCase(pages,test),fixture.key+": injected fault was missed");
   Object.assign(target,previous);injections++;
  }
 }finally{await pdf.destroy();}
}
console.log(JSON.stringify({samples:fixtures.length,pages:pagesChecked,referenceChecks:checks,injectedFailuresDetected:injections}));
