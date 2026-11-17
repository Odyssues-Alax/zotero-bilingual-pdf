// Bibliography evidence is contextual. A table column called References is not a section.
export function literal(record){return (record.text||"").replace(/⟦M\d+⟧/g,t=>record.math?.[t]?.text||t).replace(/\[\s*(\d+)\s*\]/g,"[$1]").trim();}
export const referenceTitle=text=>/^(?:[■▪•◆●\s]*)(?:\d+\.?\s+)?(?:references|bibliography)\s*$/i.test(text);
export function bibliographyEntry(text){
 return /^(?:\[\d+\]|\(\d+\)|\d+[.)])\s*(?:[a-z][.)]\s*)?(?:(?:[A-Z]\.\s*){1,3}[A-ZÀ-Ž][\p{L}'’-]+|[A-ZÀ-Ž][\p{L}'’-]+(?:\s+[A-ZÀ-Ž][\p{L}'’-]+)*\s+[A-Z]{1,4}\s*[,;]|[A-ZÀ-Ž][\p{L}'’-]+,\s*(?:[A-Z]\.\s*){1,3})/u.test(text);
}
export function tableReferenceTitle(record,records,width){
 if(!referenceTitle(literal(record)))return false;
 const near=records.filter(r=>Math.abs(r.y-record.y)<Math.max(4,record.fs*.8)&&literal(r).length<80);
 const xs=[...new Set(near.map(r=>Math.round(r.x/8)))];
 if(xs.length>=3&&Math.max(...near.map(r=>r.x+r.w))-Math.min(...near.map(r=>r.x))>width*.35)return true;
 return records.some(r=>/^Table\s*S?\s*\d/i.test(literal(r))&&record.y>r.y&&record.y-r.y-r.h<Math.max(20,record.fs*4)&&record.x>width*.7);
}
export function referenceMarkers(blocks){return blocks.flatMap(b=>{
 const lines=(b.lines||[]).filter(l=>bibliographyEntry(literal(l)));if(lines.length)return lines.map(l=>({id:b.id,x:l.x,y:l.y}));
 return bibliographyEntry(literal(b))?[{id:b.id,x:b.x,y:b.y}]:[];
});}
