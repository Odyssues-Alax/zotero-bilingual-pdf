import {problem} from "./issues.mjs";
// Use locally installed fonts; proprietary font files are never shipped in the addon.
export function normalizeMathLetters(text){
  return text.replace(/[\u{1D400}-\u{1D7FF}]/gu,c=>c.normalize("NFKC"));
}
export function extractFont(bytes,index=0){
  bytes=new Uint8Array(bytes);const input=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(input.getUint32(0)!==0x74746366)return bytes;
  const start=input.getUint32(12+index*4),count=input.getUint16(start+4);
  let size=12+count*16;const tables=[];
  for(let i=0;i<count;i++){
    const p=start+12+i*16,length=input.getUint32(p+12);
    tables.push({tag:input.getUint32(p),checksum:input.getUint32(p+4),source:input.getUint32(p+8),length,offset:size});
    size+=Math.ceil(length/4)*4;
  }
  const result=new Uint8Array(size),view=new DataView(result.buffer);
  result.set(bytes.subarray(start,start+12));
  let head;
  tables.forEach((t,i)=>{
    const p=12+i*16;view.setUint32(p,t.tag);view.setUint32(p+4,t.checksum);view.setUint32(p+8,t.offset);view.setUint32(p+12,t.length);
    result.set(bytes.subarray(t.source,t.source+t.length),t.offset);
    if(t.tag===0x68656164){head=t.offset;view.setUint32(head+8,0);}
  });
  let sum=0;for(let i=0;i<size;i+=4)sum=(sum+view.getUint32(i))>>>0;
  if(head!==undefined)view.setUint32(head+8,(0xB1B0AFBA-sum)>>>0);
  return result;
}
export async function embedReadingFonts(doc,bytes,text="",fontkit=null){
  if(!bytes.song)return await doc.embedFont(bytes,{subset:false});
  const song=await doc.embedFont(extractFont(bytes.song),{subset:false});
  const times=await doc.embedFont(new Uint8Array(bytes.times),{subset:false});
  const entries=[song,times].map((font,i)=>({font,chars:new Set(font.getCharacterSet()),face:fontkit?.create(i?new Uint8Array(bytes.times):extractFont(bytes.song))}));
  const needed=new Set([...text].filter(c=>!entries.some(e=>e.chars.has(c.codePointAt(0)))));
  // Optional fonts are embedded only when they cover a missing character.
  for(const data of bytes.fallbacks||[]){
    if(!needed.size)break;
    try{
      const raw=extractFont(data.bytes,data.index||0);
      const face=fontkit?.create(raw),coverage=face?new Set(face.characterSet):null;
      if(coverage&&![...needed].some(c=>coverage.has(c.codePointAt(0))))continue;
      const font=await doc.embedFont(raw,{subset:false});
      const chars=new Set(font.getCharacterSet());
      entries.push({font,chars,face});
      for(const char of needed)if(chars.has(char.codePointAt(0)))needed.delete(char);
    }catch(_){/* An optional font must never prevent recovery using the other fonts. */}
  }
  const chinese=/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
  const choose=char=>{
    const preferred=chinese.test(char)?entries[0]:entries[1],code=char.codePointAt(0);
    return (preferred.chars.has(code)?preferred:entries.find(e=>e.chars.has(code)))?.font;
  };
  const bounds=new Map();
  return {
    boundsOfTextAtSize(text,size){
      let minY=0,maxY=0;
      for(const c of text){const font=choose(c),entry=entries.find(e=>e.font===font);
        const key=entries.indexOf(entry)+"|"+c;let b=bounds.get(key);
        if(!b){const glyph=entry?.face?.glyphForCodePoint(c.codePointAt(0)),box=glyph?.bbox;b=box?{minY:box.minY/entry.face.unitsPerEm,maxY:box.maxY/entry.face.unitsPerEm}:{minY:-.22,maxY:1};bounds.set(key,b);}
        minY=Math.min(minY,b.minY*size);maxY=Math.max(maxY,b.maxY*size);
      }
      return {minY,maxY};
    },
    fontForText:text=>choose([...text][0])||times,
    canRenderText:text=>{const f=choose([...text][0]);return !!f&&[...text].every(c=>choose(c)===f);},
    getCharacterSet:()=>[...new Set(entries.flatMap(e=>[...e.chars]))],
    supports:char=>!!choose(char),
    widthOfTextAtSize(text,size){return [...text].reduce((w,c)=>w+(choose(c)||times).widthOfTextAtSize(c,size),0);}
  };
}

// Scan the full cached translation before any network request. Newly received text
// is scanned again by makePDF, using the same preferred/fallback coverage policy.
export function fontPreflight(pages,translations,bytes,fontkit){
  const supported=new Set();
  if(!bytes.song)return [];
  for(const data of [{bytes:bytes.song,index:0,required:true},{bytes:bytes.times,index:0,required:true},...(bytes.fallbacks||[])]){
    try{const face=fontkit.create(extractFont(data.bytes,data.index||0));for(const code of face.characterSet)supported.add(code);}
    catch(e){if(data.required)throw new Error("无法读取首选字体字形，译文缓存已保留。");}
  }
  const issues=[];
  for(const p of pages)for(const b of p.blocks.filter(b=>b.selected&&translations[b.id])){
    for(const c of new Set(normalizeMathLetters(translations[b.id]).replace(/⟦M\d+⟧/g,"")))if(!/\s/.test(c)&&c!=="✉"&&!supported.has(c.codePointAt(0))){
      const code="U+"+c.codePointAt(0).toString(16).toUpperCase();issues.push(problem("font_missing","首选和后备字体均未覆盖字符“"+c+"”（"+code+"）。修改字符或明确保留原文后继续。",[b.id],code));
    }
  }
  return issues;
}
