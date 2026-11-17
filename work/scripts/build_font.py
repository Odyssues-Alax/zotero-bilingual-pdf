from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
root=Path(__file__).resolve().parents[1]
src=root/"build"/"NotoSansSC-VF.ttf"
font=TTFont(src)
font=instantiateVariableFont(font,{"wght":400},inplace=True)
for table in ("GSUB","GPOS"):
    if table in font: del font[table]
for name in font["name"].names:
    if name.nameID in (1,2,4,6):
        value={1:"Bilingual Chinese",2:"Regular",4:"Bilingual Chinese Regular",6:"BilingualChinese-Regular"}[name.nameID]
        name.string=value.encode(name.getEncoding())
font.save(root/"addon"/"content"/"vendor"/"Chinese-Regular.ttf")
print("Static Chinese font generated.")
