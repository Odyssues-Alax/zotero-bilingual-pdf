import assert from "node:assert/strict";
import {validateParagraph} from "../addon/content/core.mjs";
import {scientificInventory} from "../addon/content/symbols.mjs";
import {classify,groupedIssues} from "../addon/content/issues.mjs";
import {completionMessage,previewFailureMessage,issueGuidance} from "../addon/content/reader-feedback.mjs";
import {recoverDrafts} from "../addon/content/repair.mjs";
import {resolveDraft} from "../addon/content/drafts.mjs";
import {logicalJobs} from "../addon/content/flow.mjs";
const passed=[],check=(name,fn)=>{fn();passed.push(name);},block=text=>({id:"p1b1",text,math:{},page:1,selected:true});
for(const name of ["ABC-12","MX-8C","4H-SiC","ZnIn2S4","DFT-D3"]){check("repeated scientific identity "+name,()=>{const b=block(`The ${name} sample was illuminated. The ${name} sample was stable.`);assert.equal(validateParagraph(b,`${name}样品在光照下保持稳定。`),`${name}样品在光照下保持稳定。`);assert(scientificInventory(b.text).identifiers.has(name));});}
check("PDF line-wrap hyphen does not invent an identifier",()=>assert.equal(validateParagraph(block("The instrument model is ES- CALAB250Xi."),"仪器型号为ESCALAB250Xi。"),"仪器型号为ESCALAB250Xi。"));
check("scientific identifier change remains blocked",()=>assert.throws(()=>validateParagraph(block("Sample ABC-12 responds to light."),"样品ABC-13响应光照。"),e=>e.code==="translation_identifier"));
check("negative sign remains mandatory",()=>assert.throws(()=>validateParagraph(block("The voltage is -0.67 V."),"电压为0.67 V。"),e=>e.code==="translation_science"));
check("actual measurement value remains mandatory",()=>assert.throws(()=>validateParagraph(block("The current is 5.2 nA."),"电流为5.3 nA。")));
check("unit cannot silently change",()=>assert.throws(()=>validateParagraph(block("The current is 5.2 mA."),"电流为5.2 A。")));
check("separate repeated measurements remain counted",()=>assert.throws(()=>validateParagraph(block("Both 5 nA and 5 nA were measured."),"测得5 nA。")));
check("unit exponents and pH are not sample codes",()=>{const v=scientificInventory("5 mW cm-2 at pH7 and 10 e-4");for(const id of ["cm-2","pH7","e-4"])assert(!v.identifiers.has(id));assert(v.numbers.has("-2")&&v.numbers.has("7")&&v.numbers.has("-4"));});
check("model identifiers cannot bypass formula ownership",()=>assert.throws(()=>validateParagraph({...block("The ABC-12 sample is stable."),math:{"⟦M1⟧":{}}},"ABC-12样品稳定。")));
check("first failure does not invent previous PDF",()=>{const v=completionMessage({done:3,total:4,groups:1,pending:1});assert(v.includes("尚未生成"));assert(!v.includes("上一份"));});
check("reading preview is visibly incomplete",()=>{const v=completionMessage({done:3,total:4,groups:1,pending:1,preview:true});assert(v.includes("标记处仍为原文"));});
check("same cause grouped despite different values",()=>assert.equal(groupedIssues([{code:"translation_science",detail:"-4",blockIDs:["a"]},{code:"translation_science",detail:"-16",blockIDs:["b"]}]).length,1));
check("missing glyph groups keep distinct characters",()=>assert.equal(groupedIssues([{code:"font_missing",detail:"U+2709",blockIDs:["a"]},{code:"font_missing",detail:"U+1F600",blockIDs:["b"]}]).length,2));
check("original evidence survives error classification",()=>{const evidence={differences:[{kind:"number",value:"-0.67"}]};assert.deepEqual(classify({code:"translation_science",message:"核对",evidence}).evidence,evidence);});
check("scientific preview does not recommend changing typography",()=>{const msg=previewFailureMessage([{stage:"translation",message:"电位缺负号"}],true);assert(msg.includes("电位缺负号")&&msg.includes("不能应用")&&msg.includes("无需调整"));});
check("layout recovery never suggests translation",()=>assert(issueGuidance({code:"layout_space"}).hint.includes("不会重新调用翻译")));
check("new validation recovers old draft locally",()=>{const b=block("The ABC-12 sample responds. The ABC-12 sample is stable.");const cache={translations:{},drafts:{[b.id]:{source:b.text,text:"ABC-12样品响应光照并保持稳定。"}}};assert.deepEqual(recoverDrafts([{blocks:[b]}],cache),[b.id]);assert.equal(Object.keys(cache.translations).length,1);});
check("logical draft accessible from every continuation",()=>{
 const a={...block("The sample was illuminated"),paragraphID:"p1b1"},b={...block("and remained stable."),id:"p2b1",page:2,paragraphID:"p1b1"};
 const pages=[{blocks:[a]},{blocks:[b]}],job=logicalJobs([a,b])[0],cache={paragraphDrafts:{[job.id]:{source:job.text,text:"样品在光照下保持稳定。"}}};
 for(const fragment of [a,b]){const result=resolveDraft(pages,cache,fragment);assert.equal(result.scope,"paragraph");assert.equal(result.source,job.text);assert.equal(result.text,"样品在光照下保持稳定。");}
 cache.paragraphDrafts[job.id].source="outdated source";assert.equal(resolveDraft(pages,cache,a),null);
});
check("stale continuation context is never presented as current",()=>{
 const a={...block("The sample remains stable."),paragraphSource:"current context"};
 const cache={drafts:{[a.id]:{source:a.text,paragraphSource:"old context",text:"样品稳定。"}}};assert.equal(resolveDraft([{blocks:[a]}],cache,a),null);
});
check("valid manual translation outranks an old logical draft",()=>{
 const a={...block("The sample was illuminated"),paragraphID:"p1b1"},b={...block("and remained stable."),id:"p2b1",page:2,paragraphID:"p1b1"};
 const job=logicalJobs([a,b])[0];a.paragraphSource=b.paragraphSource=job.text;
 const cache={translations:{[a.id]:{source:a.text,paragraphSource:job.text,continuous:1,manual:true,text:"样品经光照"}},paragraphDrafts:{[job.id]:{source:job.text,text:"过期整段草稿"}}};
 const result=resolveDraft([{blocks:[a,b]}],cache,a);assert.equal(result.scope,"region");assert.equal(result.text,"样品经光照");
});
console.log(JSON.stringify({passed:passed.length,checks:passed,externalAPICalls:0}));
