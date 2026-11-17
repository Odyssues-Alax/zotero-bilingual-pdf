import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {PDFDocument,PDFName,PDFNumber,StandardFonts}=require("../build/node_modules/pdf-lib/cjs/index.js");
import * as pdfjs from "../addon/content/vendor/pdf.mjs";
import * as worker from "../addon/content/vendor/pdf.worker.mjs";
globalThis.pdfjsWorker=worker;
const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),ctx=pdf.context;
const form=(bbox,content,children={},matrix=[1,0,0,1,0,0])=>ctx.register(ctx.flateStream(content,{Type:"XObject",Subtype:"Form",BBox:bbox,Matrix:matrix,Resources:{Font:{F1:font.ref},XObject:children}}));
const add=(content,forms={})=>{const page=pdf.addPage([400,400]);page.node.set(PDFName.of("Resources"),ctx.obj({Font:{F1:font.ref},XObject:forms}));page.node.set(PDFName.of("Contents"),ctx.register(ctx.flateStream(content)));};
const text=(x,y,s)=>`BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm (${s}) Tj ET`;
const first=form([0,0,150,70],text(10,20,"VISIBLE")+text(10,110,"GHOST"));
add(`q 1 0 0 1 30 40 cm /A Do Q ${text(30,150,"BODY")}`,{A:first});
const child=form([0,0,200,200],text(10,20,"INNER")+text(10,100,"CLIPPED"));
const outer=form([0,0,140,70],"q 1.2 0 0 1.2 5 5 cm /C Do Q",{C:child});
add("q 0 1 -1 0 250 30 cm /A Do Q",{A:outer});
const repeated=form([0,0,180,180],text(10,100,"REAPPEARS"));
const small=form([0,0,180,30],"/C Do",{C:repeated});
const large=form([0,0,180,180],"/C Do",{C:repeated});
add("/A Do /B Do",{A:small,B:large});
const edge=form([0,0,120,30],text(10,-1,"EDGE")+text(10,-40,"HIDDEN"));
add("q -1 0 0 1 160 60 cm /A Do Q",{A:edge});
// Rotated narrow Form: outside its polygon but inside the enclosing AABB.
const rotated=form([0,0,140,18],text(10,3,"ROTATED")+text(10,40,"OUTSIDE"));
add("q .707 .707 -.707 .707 150 100 cm /A Do Q",{A:rotated});
const dictionaryMatrix=form([0,0,140,25],text(10,5,"MATRIX")+text(10,80,"ABSENT"),{},[0,.8,-.8,0,90,40]);
add("/A Do",{A:dictionaryMatrix});
const spacing=form([30,0,150,40],"BT /F1 10 Tf 10 Tc 7 Tw 1 0 0 1 0 10 Tm (A BCD) Tj ET");
add("/A Do",{A:spacing});
const doc=await pdfjs.getDocument({data:await pdf.save(),useSystemFonts:true,isEvalSupported:false}).promise;
const values=[];
for(let n=1;n<=doc.numPages;n++){const t=await (await doc.getPage(n)).getTextContent();values.push({text:t.items.map(i=>i.str).join(" "),visibility:t.zbpVisibility,firstX:t.items.find(i=>i.str.trim())?.transform[4]});}
assert.match(values[0].text,/VISIBLE/);assert.match(values[0].text,/BODY/);assert.doesNotMatch(values[0].text,/GHOST/);
assert.match(values[1].text,/INNER/);assert.doesNotMatch(values[1].text,/CLIPPED/);
assert.match(values[2].text,/REAPPEARS/);assert.equal(values[2].text.match(/REAPPEARS/g).length,1);
assert.match(values[3].text,/EDGE/);assert.doesNotMatch(values[3].text,/HIDDEN/);
assert.match(values[4].text,/ROTATED/);assert.doesNotMatch(values[4].text,/OUTSIDE/);
assert(values.every(v=>v.visibility.checked>0&&v.visibility.clipped>0));
assert.match(values[5].text,/MATRIX/);assert.doesNotMatch(values[5].text,/ABSENT/);
assert.equal(values[6].text.replace(/\s+/g," "),"B C D");assert(Math.abs(values[6].firstX-36.45)<.02);
await doc.destroy();
let real=null;
if(process.argv[2]){
 const doc=await pdfjs.getDocument({data:new Uint8Array(await fs.readFile(process.argv[2])),useSystemFonts:true,isEvalSupported:false}).promise;
 const pages=[];for(let n=1;n<=doc.numPages;n++){const t=await (await doc.getPage(n)).getTextContent();pages.push({number:n,text:t.items.map(i=>i.str).join(" "),visibility:t.zbpVisibility||{checked:0,clipped:0},items:t.items});}
 assert(!pages[3].text.includes("Firstly"));assert(pages[3].text.includes("microstructure"));
 real={pages:pages.map(({number,visibility})=>({number,...visibility}))};
 if(process.argv[3])await fs.writeFile(process.argv[3],JSON.stringify(pages,null,2));
 await doc.destroy();
}
console.log(JSON.stringify({passed:16,fixtures:values,real}));
