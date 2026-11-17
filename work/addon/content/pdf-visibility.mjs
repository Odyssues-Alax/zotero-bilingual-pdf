// Conservative PDF Form BBox visibility, in page user space.
// Discard only glyphs wholly outside the intersection of all enclosing Forms.
const point=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
export function formClip(clips,bbox,matrix){
  if(!Array.isArray(bbox)||bbox.length!==4||!bbox.every(Number.isFinite))return clips;
  const [x0,y0,x1,y1]=bbox;
  return [...clips,[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(([x,y])=>point(matrix,x,y))];
}
function intersect(subject,clip){
  const signed=clip.reduce((s,a,i)=>{const b=clip[(i+1)%clip.length];return s+a[0]*b[1]-b[0]*a[1];},0);
  if(Math.abs(signed)<1e-10)return [];
  const orientation=Math.sign(signed);
  for(let i=0;i<clip.length&&subject.length;i++){
    const a=clip[i],b=clip[(i+1)%clip.length];
    const side=p=>orientation*((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]));
    const output=[];let previous=subject.at(-1),dp=side(previous);
    for(const current of subject){const dc=side(current);
      if((dc>=0)!==(dp>=0)){const t=dp/(dp-dc);output.push([previous[0]+t*(current[0]-previous[0]),previous[1]+t*(current[1]-previous[1])]);}
      if(dc>=0)output.push(current);previous=current;dp=dc;
    }
    subject=output;
  }
  return subject;
}
export function glyphInFormClips(clips,matrix,advance,fontSize,font){
  if(!clips.length||!fontSize)return true;
  // Allow bearings/diacritics and edge-straddling ink. Width is already in text
  // space; the text transform carries font size, hscale, rotation and CTM.
  const width=advance/fontSize;
  const lo=Math.min(Number.isFinite(font.descent)?font.descent:-.3,-.3);
  const hi=Math.max(Number.isFinite(font.ascent)?font.ascent:1.1,1.1);
  const rect=font.vertical?[-1,Math.min(lo,width-1),1,Math.max(hi,width+1)]:[Math.min(0,width)-.2,lo,Math.max(0,width)+.2,hi];
  let glyph=[[rect[0],rect[1]],[rect[2],rect[1]],[rect[2],rect[3]],[rect[0],rect[3]]].map(([x,y])=>point(matrix,x,y));
  for(const clip of clips){glyph=intersect(glyph,clip);if(!glyph.length)return false;}
  return true;
}
