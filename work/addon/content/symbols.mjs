// Scientific text integrity: never infer a symbol from its broken character code.
export const SYMBOL_REVISION="1.2.3-symbol1";
const broken=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd\ufffe\uffff\ud800-\udfff\ue000-\uf8ff\u{f0000}-\u{10ffff}]/u;
export const hasBroken=text=>broken.test(text||"");
export const visibleSymbols=text=>[...(text||"")].map(c=>hasBroken(c)?"〔U+"+c.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")+"〕":c).join("");
const codeList=text=>[...new Set([...text].filter(hasBroken).map(c=>"U+"+c.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")))].join("、");
const glyphNames={minus:"−",plus:"+",plusminus:"±",multiply:"×",divide:"÷",equal:"=",less:"<",greater:">",lessequal:"≤",greaterequal:"≥",notequal:"≠",mu:"μ",Omega:"Ω",alpha:"α",beta:"β",gamma:"γ",delta:"δ",lambda:"λ",Delta:"Δ",degree:"°"};
function glyphUnicode(name){
 if(glyphNames[name])return glyphNames[name];
 const m=/^(?:uni([0-9a-f]{4})|u([0-9a-f]{4,6}))$/i.exec(name||"");
 if(!m)return null;const n=parseInt(m[1]||m[2],16);if(n>0x10ffff)return null;const c=String.fromCodePoint(n);return hasBroken(c)||/\s/.test(c)?null:c;
}
export function fontSymbolHints(page,operators,OPS,fontkit){
 const hints=new Map(),faces=new Map();let font=null;
 for(let i=0;i<operators.fnArray.length;i++){
  if(operators.fnArray[i]===OPS.setFont)font=operators.argsArray[i][0];
  if(operators.fnArray[i]!==OPS.showText)continue;
  for(const g of operators.argsArray[i][0]||[]){
   if(!g||typeof g!=="object"||!hasBroken(g.unicode))continue;
   let f;try{f=page.commonObjs.get(font);}catch{}
   let value=glyphUnicode(f?.differences?.[g.originalCharCode]);
   // A subset font may call its minus glyph C0/eth. Accept only a single,
   // closed, very thin horizontal contour at the mathematical axis. Other
   // shapes retain the original glyph; the control code itself is never used.
   if(!value&&f?.data&&fontkit&&g.fontChar)try{
    if(!faces.has(font))faces.set(font,fontkit.create(f.data));
    const face=faces.get(font),glyph=face.glyphForCodePoint(g.fontChar.codePointAt(0)),box=glyph.bbox,commands=glyph.path.commands,u=face.unitsPerEm,w=box.maxX-box.minX,h=box.maxY-box.minY;
    const one=commands.filter(c=>c.command==="moveTo").length===1&&commands.filter(c=>c.command==="closePath").length===1;
    const bounded=commands.every(c=>c.args.every((v,i)=>i%2?v>=box.minY-.01&&v<=box.maxY+.01:v>=box.minX-.01&&v<=box.maxX+.01));
    if(one&&bounded&&w/u>=.35&&w/u<=1.2&&h/u>=.008&&h/u<=.07&&w/h>=7&&(box.minY+box.maxY)/2/u>=.16&&(box.minY+box.maxY)/2/u<=.36)value="−";
   }catch{}
   if(!value)continue;
   const key=font+"|"+g.unicode;
   if(!hints.has(key))hints.set(key,value);else if(hints.get(key)!==value)hints.set(key,null);
  }
 }
 return hints;
}
export function guardSourceBlocks(blocks,hints=new Map(),overrides={},pageNumber=0){
 for(const b of blocks){
  const previous={text:b.text,symbols:b.symbols||[]};
  b.symbolOriginal ||= {text:b.text,math:{...b.math}};
  b.symbolPrevious=previous;b.text=b.symbolOriginal.text;b.math={...b.symbolOriginal.math};b.symbols=[];
  let serial=Math.max(0,...Object.keys(b.math).map(t=>Number(t.match(/\d+/)?.[0]||0)));
  for(const l of b.lines||[])for(const p of l.parts||[]){
   if(!hasBroken(p.text))continue;
   const override=overrides[pageNumber+"|"+p.sourceIndex];
   const manual=override?.source===p.text&&override.blockSource===b.symbolOriginal.text&&!hasBroken(override.replacement)&&!!override.replacement?.trim()?override.replacement:null;
   const mapped=[...p.text].map(c=>hasBroken(c)?hints.get(p.font+"|"+c)||c:c).join("");
   const replacement=manual||(!hasBroken(mapped)?mapped:null);
   const existing=Object.keys(b.math).find(t=>b.math[t].sourceIndex===p.sourceIndex);
   const entry={sourceIndex:p.sourceIndex,legacy:p.text,detail:codeList(p.text),x:p.x,y:p.y,w:p.w,h:p.h,method:manual?"manual":replacement?"font-map":"original-glyph"};
   if(existing){
    entry.token=existing;entry.target=existing;
    b.math[existing]={...b.math[existing],text:replacement||p.text,originalGlyph:!replacement,symbolGuard:true};
   }else if(replacement){
    entry.target=replacement;b.text=b.text.replace(p.text,()=>replacement);
   }else if(p.w>0&&p.h>0&&p.text.length<=28&&(p.text.match(/[A-Za-z]{2,}/g)||[]).length<=1){
    const token="⟦M"+(++serial)+"⟧";entry.token=token;entry.target=token;
    b.math[token]={...p,originBaseline:l.baseline,originalGlyph:true,symbolGuard:true};b.text=b.text.replace(p.text,()=>token);
   }else{entry.method="unresolved";entry.target=p.text;}
   b.symbols.push(entry);
  }
  b.symbolRevision=SYMBOL_REVISION;
 }
 return blocks;
}
const integrityError=(code,message,detail="")=>Object.assign(new Error(message),{code,detail});
export function sourceSymbolIssues(pages){
 return pages.flatMap(p=>p.blocks.filter(b=>b.selected&&hasBroken(b.text)).map(b=>({code:"source_symbol",stage:"preflight",message:"原文存在尚不能安全分离的异常符号；请查看原文局部并确认该片段，或明确保留原文。不会猜测符号或自动发送此段。",detail:codeList(b.text),blockIDs:[b.id],retryable:false,service:false})));
}
const supers="⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉";
const normalize=text=>text.replace(/(?<=\d)[–—](?=\d)/g," 至 ").replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/g,c=>String(supers.indexOf(c)%10)).replace(/[⁻₋−–﹣－]/g,"-").replace(/[⁺₊＋]/g,"+").replace(/[０-９]/g,c=>String(c.charCodeAt(0)-0xff10)).replace(/([+-])\s+(?=\d)/g,"$1");
const plain=text=>normalize(text.replace(/\b[123]D\b/g," ").replace(/[零一二两三四五六七八九](?=个|次|倍|天|小时)/g,c=>String("零一二三四五六七八九".indexOf(c==="两"?"二":c))).replace(/⟦M\d+⟧|https?:\/\/\S+|\[[\d\s,;–−-]+\]/g," "));
function canonical(value){
 let sign="";if(/^[+-]/.test(value)){sign=value[0];value=value.slice(1);}value=value.replace(/,/g,"");
 let [a,b=""]=value.split(".");a=a.replace(/^0+(?=\d)/,"")||"0";b=b.replace(/0+$/,"");return sign+a+(b?"."+b:"");
}
const numeric=/(?<![\d.])([+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+))(?![\d.])/g;
const unit= /^(?:\s|\^|[()])*?(mL|μL|µL|L|mmol|μmol|µmol|mol|mM|μM|µM|M|kg|mg|μg|µg|g|meV|keV|eV|μm|µm|um|nm|mm|cm|mV|μV|µV|V|mA|μA|µA|nA|pA|A|mW|μW|µW|nW|W|GHz|MHz|kHz|THz|Hz|μs|µs|us|ns|ms|min|s|h|GPa|MPa|kPa|Pa|kΩ|MΩ|Ω|K|°\s*C|%|纳米|微米|毫米|厘米|毫伏|伏特|微安|毫安|纳安|安培|毫瓦|微瓦|瓦特|开尔文|赫兹|秒|小时)(?![A-Za-z])/;
const unitAliases={um:"μm","µm":"μm","µV":"μV","µA":"μA","µW":"μW",us:"μs","µs":"μs",纳米:"nm",微米:"μm",毫米:"mm",厘米:"cm",毫伏:"mV",伏特:"V",微安:"μA",毫安:"mA",纳安:"nA",安培:"A",毫瓦:"mW",微瓦:"μW",瓦特:"W",开尔文:"K",赫兹:"Hz",秒:"s",小时:"h"};
// Identifiers describe an entity, not a count of physical measurements.
// Keep each source-backed identity, while allowing repeated names to become
// implicit Chinese subjects. Units, scientific notation and pH stay numeric.
export const SCIENCE_REVISION="1.2.8";
// Element + orbital is one scientific label, not an isolated numeral (Bi 4f).
// Recognize only real element symbols and quantum numbers, not arbitrary codes.
const elements=new Set("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" "));
export function orbitalLabels(text){
 const labels=new Set();
 for(const m of normalize(text).matchAll(/(?<![A-Za-z0-9])([A-Z][a-z]?)\s*([1-7])([spdf])(?:\s*([1-9])\s*\/\s*([1-9]))?(?![A-Za-z0-9])/g)){
  if(elements.has(m[1])&&Number(m[2])>"spdf".indexOf(m[3]))labels.add(m[1]+" "+m[2]+m[3]+(m[4]?m[4]+"/"+m[5]:""));
 }
 return [...labels];
}
function splitScientificText(text){
 const identifiers=new Map();
 const value=plain(text).replace(/([A-Za-z])-\s+([A-Za-z])/g,"$1$2").replace(/(?<![A-Za-z0-9_.])(?:[0-9]+[A-Z][-_])?[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*(?![A-Za-z0-9_])/g,(token,offset,whole)=>{
  if(!/[0-9]/.test(token)||/^(?:e[+-]?[0-9]+|pH[0-9]|(?:Fig(?:ure)?|Table|Scheme|Eq(?:uation)?|Section|Ref(?:erence)?)[0-9])/i.test(token)||/^\.[0-9]/.test(whole.slice(offset+token.length)))return token;
  const u=unit.exec(token);
  if(u&&/^(?:[+-]?[0-9]+)?$/.test(token.slice(u[0].length)))return token;
  identifiers.set(token,(identifiers.get(token)||0)+1);return " ";
 });
 return {value,identifiers};
}
export function scientificInventory(text){
 const {value:s,identifiers}=splitScientificText(text),numbers=new Map(),quantities=new Map();
 for(const m of s.matchAll(numeric)){
  const n=canonical(m[1]);numbers.set(n,(numbers.get(n)||0)+1);
  const suffix=s.slice(m.index+m[0].length);const u=unit.exec(suffix)?.[1]?.replace(/\s/g,"");
  const elementCount=u&&["V","W","K","Pa"].includes(u)&&new RegExp("^\\s*"+u+"\\b(?:\\s*(?:atoms?|ions?|原子|离子)|[^.!?。！？;]{0,70}\\b(?:atoms?|ions?)\\b)","i").test(suffix)&&/contains|containing|compris|consist|含|原子|离子/i.test(s.slice(Math.max(0,m.index-100),m.index));
  if(u&&!elementCount){const q=n+" "+(unitAliases[u]||u);quantities.set(q,(quantities.get(q)||0)+1);}
 }
 return {numbers,quantities,identifiers};
}
export function validateScientificText(block,text){
 if(hasBroken(text))throw integrityError("translation_symbol","段落 "+block.id+" 含异常控制字符或无法确认的编码；不会直接写入译版。",codeList(text));
 if(hasBroken(block.text))throw integrityError("source_symbol","原文异常符号尚未确认；请先查看原文局部并确认片段。",codeList(block.text));
 if(!block.paragraphSource||block.members)validateNumericText(block,text);
 for(const e of block.symbols||[]){
  if(!e.token||e.method!=="original-glyph")continue;
  const at=block.text.indexOf(e.token)+e.token.length,match=/^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/.exec(normalize(block.text.slice(at)));
  if(match){const next=/^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/.exec(normalize(text.slice(text.indexOf(e.token)+e.token.length)));if(!next||canonical(next[1])!==canonical(match[1]))throw integrityError("translation_science","原符号与其后数值的位置发生变化；请保持 "+e.token+" 紧邻 "+match[1]+"。",e.token);}
 }
}
export function validateNumericText(block,text){
 const a=scientificInventory(block.text),b=scientificInventory(text),differences=[];
 const missingOrbitals=orbitalLabels(block.text).filter(label=>!orbitalLabels(text).includes(label));
 if(missingOrbitals.length){
  const e=integrityError("translation_science","轨道标记需要核对：译文未完整保留“"+missingOrbitals.join("、")+"”。请保留元素与轨道的对应关系及相关光谱说明。",missingOrbitals.join(" | "));
  e.evidence={differences:missingOrbitals.map(value=>({kind:"orbital",value,expected:1,actual:0}))};throw e;
 }
 for(const [n,count] of a.numbers)if((b.numbers.get(n)||0)<count)differences.push({kind:"number",value:n,expected:count,actual:b.numbers.get(n)||0});
 for(const [q,count] of a.quantities)if((b.quantities.get(q)||0)<count)differences.push({kind:"quantity",value:q,expected:count,actual:b.quantities.get(q)||0});
 for(const name of a.identifiers.keys())if(!b.identifiers.has(name))differences.push({kind:"identifier",value:name,expected:1,actual:0});
 if(differences.length){
  const names=[...new Set(differences.map(d=>d.value))],identifiersOnly=differences.every(d=>d.kind==="identifier");
  const code=identifiersOnly?"translation_identifier":"translation_science";
  const e=integrityError(code,(identifiersOnly?"材料或样品编号":"数值、正负号或单位")+"需要核对：原文含“"+names.slice(0,8).join("、")+"”，译文未完整保留。已保留原文和草稿，插件会优先在本机重新核对。",names.join(" | "));
  e.evidence={differences};throw e;
 }
}
export function auditScientificDocument(pages,translations){
 const groups=new Map(),issues=[];
 for(const b of pages.flatMap(p=>p.blocks.filter(b=>b.selected))){const key=b.paragraphID||b.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
 for(const [id,members] of groups){
  if(members.some(b=>typeof translations[b.id]!=="string"))continue;
  members.sort((a,b)=>(a.readingIndex??(a.page*1000000+a.y))-(b.readingIndex??(b.page*1000000+b.y)));
  try{validateNumericText({id,text:members.map(b=>b.text).join(" ")},members.map(b=>translations[b.id]).join(" "));}
  catch(e){issues.push({code:e.code,stage:"translation",message:e.message,detail:e.detail,evidence:e.evidence,blockIDs:members.map(b=>b.id),retryable:true,service:false});}
 }
 return issues;
}
export function adaptSymbolTranslation(value,source,block){
 if(source===block.text)return value;
 let previous;
 if(source===block.symbolOriginal?.text)previous=(block.symbols||[]).filter(e=>!Object.prototype.hasOwnProperty.call(block.symbolOriginal.math,e.token)).map(e=>({from:e.legacy,to:e.target}));
 else if(source===block.symbolPrevious?.text)previous=(block.symbolPrevious.symbols||[]).map(old=>({from:old.target,to:block.symbols.find(e=>e.sourceIndex===old.sourceIndex)?.target??old.target}));
 else return null;
 // Existing formula tokens remain local and stable. Require matching counts;
 // a previously deleted sign is not reinserted by guessing a sentence position.
 const grouped=new Map();for(const e of previous.filter(e=>e.from!==e.to)){if(!grouped.has(e.from))grouped.set(e.from,[]);grouped.get(e.from).push(e.to);}
 for(const [from,targets] of grouped){if(value.split(from).length-1!==targets.length){if(targets.every(t=>!hasBroken(t)&&!t.includes("⟦"))&&targets.every(t=>normalize(value).includes(normalize(t))))continue;return null;}let n=0;value=value.split(from).map((part,i)=>(i?targets[n++]:"")+part).join("");}
 return value;
}
export function symbolSummary(pages){
 const entries=pages.flatMap(p=>p.blocks.filter(b=>b.selected).flatMap(b=>b.symbols||[]));
 return {revision:SYMBOL_REVISION,protected:entries.filter(e=>e.method==="original-glyph").length,mapped:entries.filter(e=>e.method==="font-map").length,confirmed:entries.filter(e=>e.method==="manual").length,unresolved:entries.filter(e=>e.method==="unresolved").length};
}
