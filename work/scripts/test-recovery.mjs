import assert from "node:assert/strict";
import fs from "node:fs";
import {translate} from "../addon/content/core.mjs";
import {translateLogical} from "../addon/content/flow.mjs";
import {recovery,canAttempt,reserveAttempt,resetAttempts,groupedIssues,sourcePreflight,classify} from "../addon/content/issues.mjs";
const checks=[];const check=(name,ok)=>{assert(ok,name);checks.push(name);};
const settings={baseURL:"https://fixture.invalid",model:"fixture"};
const a={id:"p1b1",text:"The measured current increases under illumination.",math:{}},b={...a,id:"p1b2",text:"Another complete scientific paragraph."};
let cache={},store=recovery(cache),saved=0,calls=0;
const policy={canAttempt:j=>canAttempt(store,j),beforeRequest:async js=>{assert(js.every(j=>canAttempt(store,j)));for(const j of js)reserveAttempt(store,j);cache=JSON.parse(JSON.stringify(cache));store=recovery(cache);saved++;}};
const response=translations=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations})}}]}),{status:200});
let e;
try{await translate([a,b],settings,"",undefined,async(_url,req)=>{calls++;const js=JSON.parse(req.body).messages[1].content;return response(JSON.parse(js).paragraphs.map(j=>({id:j.id,text:j.id===a.id?"Still English only.":"另外一段完成翻译。"})));},policy);}catch(x){e=x;}
check("bad paragraph keeps later valid result",e.partial[b.id]==="另外一段完成翻译。");
check("only failed paragraph retried",calls===2&&saved===2);
check("all failures expose structured physical locations",e.issues[0].code==="translation_english"&&e.blockIDs.includes(a.id));
check("serialized recovery retains exhausted budget",!canAttempt(store,a)&&canAttempt(store,b));
const again=[a].filter(j=>canAttempt(store,j));check("normal generation does not reset attempts",again.length===0);
check("changed source gets fresh attempts",canAttempt(store,{...a,text:a.text+" New evidence."}));
resetAttempts(store,[a]);check("explicit retry resets only chosen job",canAttempt(store,a)&&store.attempts[b.id].count===1);
store.service=classify(new Error("API Key 无效（401）"));check("service circuit blocks every job",![a,b].some(j=>canAttempt(store,j)));resetAttempts(store,[]);
const groups=groupedIssues([{code:"font_missing",detail:"U+10FFFF",message:"missing",blockIDs:[a.id]},{code:"font_missing",detail:"U+10FFFF",message:"missing",blockIDs:[b.id]}]);check("same missing glyph grouped across paragraphs",groups.length===1&&groups[0].blockIDs.length===2);
const issues=sourcePreflight([{width:600,height:800,blocks:[{...a,selected:true,x:30,y:30,w:250,h:80,reason:"跨栏文本"},{...b,selected:true,x:30,y:180,w:-2,h:80}]}]);check("preflight collects all source problems",issues.length===2);
cache={};store=recovery(cache);calls=0;
try{await translate([a,b],settings,"",undefined,async()=>{calls++;return new Response("",{status:429});},policy);}catch(x){e=x;}
check("rate limit never exceeds two HTTP attempts",calls===2);
check("exhausted rate failure stays a service problem",classify(e).code==="service_rate");
cache={};store=recovery(cache);calls=0;
const fetcher=async(_url,req)=>{calls++;if(calls===1)return new Response(JSON.stringify({choices:[{message:{content:"{broken"}}]}),{status:200});return response(JSON.parse(JSON.parse(req.body).messages[1].content).paragraphs.map(j=>({id:j.id,text:"完成的中文译文。"})));};
const values=await translate([a,b],settings,"",undefined,fetcher,policy);check("malformed batch repaired per paragraph",calls===3&&Object.keys(values).length===2);
check("each malformed-batch job uses at most two attempts",Object.values(store.attempts).every(v=>v.count===2));
const linked=[{...a,paragraphID:a.id,page:1,column:0,y:10},{...b,paragraphID:a.id,page:2,column:0,y:10}];
try{await translateLogical(linked,settings,"",undefined,async js=>{const x=new Error("bad");x.blockID=js[0].id;x.issues=[{...classify(new Error("仍含英文")),blockIDs:[js[0].id]}];x.drafts={[js[0].id]:"Still English."};throw x;});}catch(x){e=x;}
check("logical failure maps all linked physical regions",e.issues[0].blockIDs.length===2&&e.paragraphDrafts["paragraph-p1b1"]);
cache={};store=recovery(cache);calls=0;const controller=new AbortController();let checkpoint=null;
const cancelPolicy={...policy,onValid:async values=>{checkpoint={...values};}};
try{await translate([a,b],settings,"",controller.signal,async(_url,req)=>{calls++;if(calls===1)return response([{id:a.id,text:"Still English."},{id:b.id,text:"已经完成的中文。"}]);controller.abort();throw new DOMException("cancel","AbortError");},cancelPolicy);}catch(x){e=x;}
check("valid batch results checkpoint before failed-paragraph retry",checkpoint[b.id]==="已经完成的中文。"&&e.name==="AbortError");
const report={passed:checks.length,checks,externalAPICalls:0};fs.writeFileSync(new URL("../qa-118-supervisor-report.json",import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
