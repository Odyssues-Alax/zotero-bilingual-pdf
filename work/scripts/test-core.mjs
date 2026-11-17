import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {validateTranslation,validateParagraph,translate,fit,batches,aborted,segment} from "../addon/content/core.mjs";
const passed=[];
const test=async(name,fn)=>{await fn();passed.push(name);};
const b={id:"p1b1",text:"This scientific article describes the signal.",math:{}};
const raw=(id="p1b1",text="这篇论文描述了信号。")=>JSON.stringify({translations:[{id,text}]});
await test("严格匹配段落 ID",()=>assert.throws(()=>validateTranslation(raw("wrong"),[b])));
await test("拒绝缺失段落",()=>assert.throws(()=>validateTranslation('{"translations":[]}',[b])));
await test("拒绝重复段落",()=>assert.throws(()=>validateTranslation('{"translations":[{"id":"p1b1","text":"中文"},{"id":"p1b1","text":"中文"}]}',[b])));
await test("拒绝空译文",()=>assert.throws(()=>validateTranslation(raw("p1b1",""),[b])));
await test("拒绝未翻译英文",()=>assert.throws(()=>validateTranslation(raw("p1b1","Still English"),[b])));
await test("接受完整中文",()=>assert.equal(validateTranslation(raw(),[b]).p1b1,"这篇论文描述了信号。"));
await test("保留公式占位符",()=>assert.throws(()=>validateTranslation(raw(),[{...b,math:{"⟦M1⟧":{}}}])));
await test("允许带完整公式的译文",()=>assert.equal(validateTranslation(raw("p1b1","表达式 ⟦M1⟧。"),[{...b,math:{"⟦M1⟧":{}}}]).p1b1,"表达式 ⟦M1⟧。"));
const settings={baseURL:"https://fixture.invalid/v1",model:"fixture-model"};
await test("API 请求格式及中文 JSON 响应",async()=>{
 let request;
 const output=await translate([b],settings,"",undefined,async(url,options)=>{request={url,body:JSON.parse(options.body)};return new Response(JSON.stringify({choices:[{message:{content:raw()},finish_reason:"stop"}]}),{status:200});});
 assert.equal(request.url,"https://fixture.invalid/v1/chat/completions");
 assert.equal(request.body.response_format.type,"json_object");
 assert(request.body.messages[0].content.includes('{"translations"'));
 assert.equal(output.p1b1,"这篇论文描述了信号。");
});
await test("401 立即失败且不重复调用",async()=>{
 let calls=0;
 await assert.rejects(()=>translate([b],settings,"",undefined,async()=>{calls++;return new Response("",{status:401});}),/API Key/);
 assert.equal(calls,1);
});
await test("429 有限重试",async()=>{
 let calls=0;
 const result=await translate([b],settings,"",undefined,async()=>{calls++;return calls===1 ? new Response("",{status:429}):new Response(JSON.stringify({choices:[{message:{content:raw()}}]}),{status:200});});
 assert.equal(calls,2);assert(result.p1b1);
});
await test("拒绝被截断的输出",async()=>await assert.rejects(()=>translate([b],settings,"",undefined,async()=>new Response(JSON.stringify({choices:[{finish_reason:"length"}]}),{status:200})),/长度/));
await test("取消在请求前生效",async()=>{const c=new AbortController();c.abort();let calls=0;await assert.rejects(()=>translate([b],settings,"",c.signal,async()=>{calls++;}),{name:"AbortError"});assert.equal(calls,0);});
await test("取消等待中的请求",async()=>{const c=new AbortController();const p=translate([b],settings,"",c.signal,async(_u,o)=>new Promise((_r,reject)=>o.signal.addEventListener("abort",()=>reject(new DOMException("cancel","AbortError")))));c.abort();await assert.rejects(()=>p,{name:"AbortError"});});
await test("文本框溢出不会被裁切",()=>{const font={widthOfTextAtSize:(t,size)=>t.length*size};assert.equal(fit({fs:10,w:10,h:10,math:{}},"这是放不下的长篇文字",font),null);});
await test("分批不遗漏或重复",()=>{const input=Array.from({length:8},(_,i)=>({...b,id:String(i),text:"x".repeat(100)}));assert.deepEqual(batches(input,250).flat().map(b=>b.id),input.map(b=>b.id));});
await test("数学字体缺失高度时使用有限值",()=>{
 const result=segment({items:[{str:"λ",width:5,height:9,fontName:"symbol",transform:[9,0,0,9,50,100]}],styles:{symbol:{ascent:NaN,descent:NaN,fontFamily:"Symbol"}}},{width:595,height:842,transform:[]},{Util:{transform:(_a,b)=>b}},1);
 assert(result.length);assert(Number.isFinite(result[0].h));assert(Number.isFinite(result[0].y));
});
await test("短正文句子也可识别",()=>{
 const result=segment({items:[{str:"The result remains reproducible across repeated experimental runs.",width:300,height:9,fontName:"body",transform:[9,0,0,9,50,100]}],styles:{body:{ascent:.8,descent:-.2}}},{width:595,height:842,transform:[]},{Util:{transform:(_a,b)=>b}},1);
 assert(result[0].selected);
});
await test("数字字形与 PDF 宽度映射一致",async()=>{
 const {createRequire}=await import("node:module");
 const require=createRequire(import.meta.url);
 const fontkit=require("../build/node_modules/@pdf-lib/fontkit");
 const font=fontkit.create(new Uint8Array(await fs.readFile(new URL("../addon/content/vendor/Chinese-Regular.ttf",import.meta.url))));
 const text="36510";
 assert.deepEqual(font.layout(text).glyphs.map(g=>g.id),[...text].map(c=>font.glyphForCodePoint(c.codePointAt(0)).id));
});
await fs.writeFile(new URL("../qa-core-report.json",import.meta.url),JSON.stringify({passed:passed.length,tests:passed},null,2));
await test("局部字号和行距覆盖可精确预排版",()=>{const r=fit({fs:10,w:100,h:100,math:{},layoutOverride:{fontSize:8,leading:1.2}},"中文译文",{widthOfTextAtSize:(t,s)=>t.length*s});assert.equal(r.size,8);assert.equal(r.leading,9.6);});
await test("超出局部排版参数范围会拒绝",()=>assert.throws(()=>fit({fs:10,w:100,h:100,math:{},layoutOverride:{fontSize:2}},"中文",{widthOfTextAtSize:()=>10}),/字号/));
await test("原文已有短出版商专名中的and不误判",()=>assert.equal(validateParagraph({id:"credit",text:"Reproduced with permission, John Wiley and Sons.",math:{}},"经许可转载，John Wiley and Sons。"),"经许可转载，John Wiley and Sons。"));
await test("正文英文连接词仍被拒绝",()=>assert.throws(()=>validateParagraph({id:"body",text:"The carrier and light response is obtained.",math:{}},"获得载流子 and 光响应。")));
await test("公式重试携带失败草稿和具体原因",async()=>{
 const block={id:"formula",text:"The current is higher than that.",math:{"⟦M1⟧":{}}};let calls=0,repair;
 const fetcher=async(_url,options)=>{const input=JSON.parse(JSON.parse(options.body).messages[1].content);calls++;if(calls===2)repair=input.paragraphs[0].repair;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations:[{id:block.id,text:calls===1?"电流⟦M1⟧高于电流⟦M1⟧。":"电流⟦M1⟧高于其值。"}]})},finish_reason:"stop"}]}));};
 const result=await translate([block],settings,"",undefined,fetcher);assert.equal(calls,2);assert(repair.previousTranslation.includes("⟦M1⟧"));assert(repair.validationError.includes("恰好"));assert.equal(result.formula,"电流⟦M1⟧高于其值。");
});
console.log(JSON.stringify({passed:passed.length}));
