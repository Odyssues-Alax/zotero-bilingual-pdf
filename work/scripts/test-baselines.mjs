import assert from 'node:assert/strict';import {segment,displayMath} from '../addon/content/core.mjs';
const Util={transform:(_a,b)=>b};const viewport={width:600,height:800,transform:[]};const styles={body:{ascent:.68,descent:-.32,fontFamily:'serif'},sup:{ascent:.68,descent:-.32,fontFamily:'serif'},symbol:{ascent:.68,descent:-.32,fontFamily:'Symbol'}};
const p=(str,x,baseline,fs=10,width=80,fontName='body')=>({str,width,height:fs,fontName,transform:[fs,0,0,fs,x,baseline]});
const extract=items=>segment({items,styles},viewport,{Util},2);const tests=[];const test=(name,fn)=>{fn();tests.push(name);};
test('上标逗号引用不拆开一行正文',()=>{const bs=extract([p('The source text ends.',50,200,10,100),p('18,19',150,196,6.7,15,'sup'),p('Combined with the next scientific statement.',169,200,10,120)]);assert.equal(bs.length,1);assert(bs[0].text.includes('Combined'));assert(bs[0].selected);});
test('先以正文字号建立基线',()=>{const bs=extract([p('2',200,203,6.7,3,'sup'),p('The scientific material is Ga',50,200,10,150),p('O',204,200,10,8),p('3',212,203,6.7,3,'sup'),p('The carrier dynamics are measured here.',50,211,10,240)]);assert.equal(bs.length,1);assert.equal(bs[0].lines.length,2);assert.equal(bs[0].lines[0].baseline,200);assert(bs[0].selected);});
test('引用关联最近的正文基线',()=>{const bs=extract([p('First text line in the journal article.',50,200,10,240),p('27−30',255,207,6.67,20,'sup'),p('Next line has the citation attached here.',50,211,10,240)]);const ref=bs.flatMap(b=>b.lines).find(l=>l.parts.some(p=>p.text==='27−30'));assert.equal(ref.baseline,211);});
test('一段中多行化学下标不引起误分段',()=>{const items=[];for(let n=0;n<5;n++){items.push(p('The material Ga',50,200+n*11,10,70),p('2',120,203+n*11,6.7,4,'sup'),p('O',124,200+n*11,10,8),p('3',132,203+n*11,6.7,4,'sup'),p('exhibits stable performance in water.',140,200+n*11,10,150));}const bs=extract(items);assert.equal(bs.length,1);assert.equal(bs[0].lines.length,5);assert(bs[0].selected);});
test('保留真正的段间空隙',()=>{const bs=extract([p('First scientific paragraph is complete.',50,200,10,240),p('Second scientific paragraph starts here.',50,225,10,240)]);assert.equal(bs.length,2);});
test('解释行内公式的正文不能当成独立公式',()=>{assert(!displayMath('photocurrent (Iph = Ilight − Idark), responsivity (R = Iph/P)'));const bs=extract([p('Generally, to quantitatively evaluate the performance,',50,200,10,240),p('photocurrent (Iph = Ilight − Idark), responsivity (R = Iph/P)',50,211,10,240),p('the carrier response is calculated under illumination.',50,222,10,240)]);assert.equal(bs.length,1);assert(bs[0].selected);assert(!bs[0].protectedFormula);});
test('纯变量和函数仍识别为独立公式',()=>assert(displayMath('y = A1 exp(t/τ1) + A2 exp(t/τ2)')));
test('符号字体中的英文说明不进入公式标记',()=>{const b=extract([p('Combined with experimental results',50,200,10,200,'symbol')])[0];assert.equal(Object.keys(b.math).length,0);assert(b.text.includes('Combined'));});
test('单栏长行跨中线时右端上标仍关联整行',()=>{const bs=extract([p('The spectral noise density is measured in Hz.',50,200,10,430),p('-1/2',481,196,6.5,14,'sup')]);assert.equal(bs.length,1);assert.equal(Object.values(bs[0].math)[0].text,'-1/2');});
test('自定义数学字体的私有编码下标仍关联正文',()=>{const bs=extract([p('where the current is represented by',50,200,10,180),p('\u0000\u{e8000}',230,202,6.5,7,'symbol'),p('and measured under illumination.',240,200,10,120)]);assert.equal(bs.length,1);assert.equal(Object.keys(bs[0].math).length,1);assert.equal(bs[0].lines[0].parts.length,3);});
test('大写开头的连接词不能作为行内公式保存',()=>{const b=extract([p('However',50,200,10,40,'symbol'),p('the response remains stable in water.',95,200,10,180)])[0];assert.equal(Object.keys(b.math).length,0);});
test('正文旁的脚注符和分数上标正确归组',()=>{for(const value of ['§','†','‡','3/2']){const bs=extract([p('The materials are characterized in water.',50,200,10,240),p(value,290,196,6.7,12,'sup')]);assert.equal(bs.length,1);assert.equal(Object.values(bs[0].math)[0].text,value);}});
test('未知变量名不必写进公式白名单',()=>assert(displayMath('Iphoto = Ilight − Idark')));
test('装饰符号不因字号大被当成标题',()=>{const bs=extract([p('A regular scientific paragraph is written here.',50,300,10,240),p('*',50,350,20,10,'symbol')]);assert(!bs.find(b=>b.y>320).selected);});
test('段末引用不掩盖下一段首行缩进',()=>{
 const bs=extract([p('First scientific paragraph ends here.',50,200,10,240),p('24−26',290,196,6.7,16,'sup'),p('In the next paragraph the experiments continue.',60,211,10,230),p('The next line belongs to the new paragraph.',50,222,10,240)]);
 assert.equal(bs.length,2);assert.equal(bs[1].lines.length,2);
});
for(const offset of [0,1,2])test(`不同字号双栏的基线必须来自本栏 offset=${offset}`,()=>{
 const items=[];for(let n=0;n<24;n++)items.push(p('The scientific abstract remains in the wide column.',50,200+n*12.95+offset,9.71,312));
 for(let n=0;n<28;n++)items.push(p('The scientific introduction remains complete.',385,200+n*10.96,8.966,162));
 const bs=extract(items),right=bs.filter(b=>b.x>380);assert.equal(right.length,1);assert(right[0].selected);assert.equal(right[0].lines.length,28);
 for(const l of right[0].lines){assert(Math.abs(l.baseline-l.parts[0].baseline)<.01);}
});
for(const offset of [0,1,2])test(`宽摘要下的双栏按局部栏缝拆分 offset=${offset}`,()=>{
 const items=[];
 for(let n=0;n<18;n++){items.push(p('Scientific abstract describes the experimental findings.',50,200+n*11,9.75,312));items.push(p('The narrow sidebar discusses earlier work.',385,200+n*11+offset,9,162));}
 for(let n=0;n<9;n++){items.push(p('The left body paragraph continues with the introduction.',50,450+n*11,9,240));if(n<3)items.push(p('The right body paragraph describes previous studies.',306,450+n*11+offset,9,240));else for(let k=0;k<3;k++)items.push(p('Right body study',306+k*80,450+n*11+offset,9,80));}
 const bs=extract(items),body=bs.filter(b=>b.y>435);
 assert(body.length>=2);assert(body.every(b=>b.w<260));assert(body.filter(b=>b.x<100).every(b=>!b.text.includes('right body')));assert(body.filter(b=>b.x>300).every(b=>!b.text.includes('left body')));
 assert(bs.find(b=>b.text.startsWith('Scientific abstract')).w>300);assert.equal(bs.find(b=>b.text.startsWith('Scientific abstract')).column,-1);
 const owned=bs.flatMap(b=>b.lines.flatMap(l=>l.parts.map(p=>p.sourceIndex)));assert.equal(owned.length,items.length);assert.equal(new Set(owned).size,items.length);
});
for(const fs of [6,8,10,12,16])for(const lead of [1.05,1.15,1.25])for(const ratio of [.6,.72]){
 test(`通用基线 fs=${fs} leading=${lead} script=${ratio}`,()=>{
  const items=[];for(let n=0;n<4;n++){
   const base=200+n*fs*lead;
   items.push(p('Scientific carrier dynamics in Ga',50,base,fs,120),p('2',170,base+fs*.25,fs*ratio,4,'sup'),p('O',174,base,fs,8),p('3',182,base+fs*.25,fs*ratio,4,'sup'),p('under illumination are measured.',186,base,fs,100));
  }
  const bs=extract(items);assert.equal(bs.length,1,`fs=${fs} leading=${lead} script=${ratio}`);assert.equal(bs[0].lines.length,4);assert(bs[0].selected);
  const indices=bs.flatMap(b=>b.lines.flatMap(l=>l.parts.map(p=>p.sourceIndex)));
  assert.equal(indices.length,items.length);assert.equal(new Set(indices).size,items.length);
 });
}
await test("多词下标保持正文行连续且源项唯一归属",()=>{
 const content={styles:{f:{ascent:.75,descent:-.25}},items:[
  {str:"The ratio of electron pairs (N",fontName:"f",width:145,height:10,transform:[10,0,0,10,50,200]},
  {str:"charge Carriers",fontName:"f",width:39,height:6.5,transform:[6.5,0,0,6.5,195,201.5]},
  {str:") which conferred the photocurrent.",fontName:"f",width:160,height:10,transform:[10,0,0,10,235,200]}
 ]};
 const bs=segment(content,{width:600,height:800,transform:[]},{Util:{transform:(_a,b)=>b}},2);
 assert.equal(bs.length,1);assert(bs[0].selected);assert(bs[0].text.includes("charge Carriers"));assert(bs[0].text.includes("which conferred"));
 const indices=bs.flatMap(b=>b.lines.flatMap(l=>l.parts.map(p=>p.sourceIndex)));assert.equal(indices.length,3);assert.equal(new Set(indices).size,3);
});
console.log(JSON.stringify({passed:tests.length,tests}));
