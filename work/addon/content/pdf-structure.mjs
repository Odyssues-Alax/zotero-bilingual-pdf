// Only use a tag when PDF.js can match the marked items back to the exact
// unmarked source items. Keep the ordinary extraction as the source of truth.
export async function readSourceTags(page,content){
 const tree=await page.getStructTree();
 if(!tree)return null;
 const links=new Map();
 let order=0;
 function collect(node,paragraph=null,table=false,caption=false){
  if(node.role==="P")paragraph=node.zbpStructRef||null;
  table ||= node.role==="Table";
  caption ||= node.role==="Caption";
  if(node.type==="content"&&node.id){
   const info={paragraph:table||caption?null:paragraph,table:table&&!caption,order:order++};
   links.set(node.id,links.has(node.id)?null:info);
  }
  for(const child of node.children||[])collect(child,paragraph,table,caption);
 }
 collect(tree);
 if(![...links.values()].some(t=>t?.paragraph||t?.table))return null;
 const marked=await page.getTextContent({includeMarkedContent:true});
 const unmarked=content.items.flatMap((item,index)=>item.str?.trim()?[{item,index}]:[]);
 const tags=new Map(),stack=[];
 let offset=0;
 for(const item of marked.items){
  if(item.type==="beginMarkedContentProps"||item.type==="beginMarkedContent"){stack.push(item.id);continue;}
  if(item.type==="endMarkedContent"){stack.pop();continue;}
  if(!item.str?.trim())continue;
  const source=unmarked[offset++];
  if(!source||source.item.str!==item.str||source.item.fontName!==item.fontName||source.item.width!==item.width||
   source.item.transform.some((value,i)=>value!==item.transform[i]))return null;
  const marker=stack.findLast(Boolean);
  const tag=links.get(marker);
  if(tag)tags.set(source.index,tag);
 }
 return offset===unmarked.length?tags:null;
}
export function applySourceTags(blocks,tags){
 if(!tags)return;
 for(const block of blocks){
  if(block.protectedFormula)continue;
  const marks=block.lines.flatMap(l=>l.parts.map(p=>tags.get(p.sourceIndex)));
  if(!marks.length||marks.some(t=>!t))continue;
  if(marks.every(t=>t.table)){
   block.baseClassification={selected:false,reason:"表格单元格（PDF 标签）",kind:"正文"};
   Object.assign(block,block.baseClassification);
  }else if(marks[0].paragraph&&marks.every(t=>t.paragraph===marks[0].paragraph)){
   block.sourceParagraph={ref:marks[0].paragraph,order:Math.min(...marks.map(t=>t.order))};
  }
 }
}
