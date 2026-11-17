import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extractFont,normalizeMathLetters,embedReadingFonts} from '../addon/content/fonts.mjs';
assert.equal(normalizeMathLetters('中文 𝛼 𝜆 𝟙 α 123'),'中文 α λ 1 α 123');
const windowsDir = process.env.WINDIR || process.env.SystemRoot;
assert.ok(windowsDir, "Windows font test requires Windows.");
const fontDir = windowsDir + "/Fonts/";
const bytes=new Uint8Array(fs.readFileSync(fontDir + "simsun.ttc"));
const result=extractFont(bytes),v=new DataView(result.buffer);
assert.equal(v.getUint32(0),0x00010000);
let sum=0;for(let i=0;i<result.length;i+=4)sum=(sum+v.getUint32(i))>>>0;assert.equal(sum,0xB1B0AFBA);
assert.deepEqual(extractFont(result),result);
let index=0;const calls=[];
const fonts=await embedReadingFonts({embedFont:async b=>{calls.push(b);const id=index++;return {id,getCharacterSet:()=>id?[65,49,945]:[20013,12290],widthOfTextAtSize:(s,z)=>s.length*z*(id?.5:1)};}},{song:bytes,times:new Uint8Array([1,2])});
assert.equal(fonts.fontForText('中').id,0);assert.equal(fonts.fontForText('。').id,0);assert.equal(fonts.fontForText('α').id,1);assert.equal(fonts.fontForText('1').id,1);
assert(fonts.supports('α'));assert(!fonts.supports('🧪'));assert.equal(fonts.widthOfTextAtSize('中A',10),15);
const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
const {PDFDocument}=require('../build/node_modules/pdf-lib');const fontkit=require('../build/node_modules/@pdf-lib/fontkit');
const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
const fallbacks=[['cambria.ttc',1],['seguisym.ttf',0],['seguiemj.ttf',0],['simsunb.ttf',0],['SimsunExtG.ttf',0]].filter(([n])=>fs.existsSync(fontDir+n)).map(([name,index])=>({name,index,bytes:new Uint8Array(fs.readFileSync(fontDir+name))}));
const real=await embedReadingFonts(doc,{song:bytes,times:new Uint8Array(fs.readFileSync(fontDir + "times.ttf")),fallbacks},'中Aα⟨⏞🜂🧪𠀀',fontkit);
assert(real.supports('⟨'));assert(real.supports('⏞'));assert(real.supports('🜂'));assert(real.supports('🧪'));assert(real.supports('𠀀'));assert(!real.supports(String.fromCodePoint(0x10ffff)));
assert(real.fontForText('中').name.includes('SimSun'));assert(real.fontForText('α').name.includes('Times'));
assert(real.fontForText('⏞').name.includes('Cambria'));assert(real.fontForText('🜂').name.includes('Segoe'));
assert(real.fontForText('𠀀').name.includes('SimSun'));assert(!real.canRenderText('α⏞'));
const page=doc.addPage([400,300]);let x=20;for(const c of '中文 Aα 123 ⟨⏞ 🜂 🧪 𠀀'){page.drawText(c,{x,y:150,size:14,font:real.fontForText(c)});x+=real.widthOfTextAtSize(c,14);}
// System fonts are not written to the repository; only the generated QA PDF embeds them.
fs.writeFileSync(new URL('../qa-112-fonts.pdf',import.meta.url),await doc.save());
console.log(JSON.stringify({passed:22}));
