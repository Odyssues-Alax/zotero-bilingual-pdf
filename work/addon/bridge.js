var ZBPBridge = {
  engine: ZBPEngine, id: null, windows: new Set(), pref: "extensions.zotero.bilingualPDF.",
  get profileRoot() { return PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "bilingual-pdf"); },
  get defaultRoot() { return PathUtils.join(this.profileRoot, "translations"); },
  async startup(id, rootURI) {
    this.id = id; this.rootURI = rootURI;this.menuIDs=[];
    for (const win of Zotero.getMainWindows()) this.addToWindow(win);
    this.menuIDs.push(Zotero.MenuManager.registerMenu({
      menuID: "zbp-open", pluginID: id, target: "main/library/item",
      menus: [{menuType:"menuitem", l10nID:"zbp-open",
        onShowing: (_e, c) => c.setVisible(c.items?.some(i => i.isAttachment() || i.isRegularItem())),
        onCommand: (_e, c) => this.openSelection(c.items).catch(e => this.alert(e))}]
    }));
    this.menuIDs.push(Zotero.MenuManager.registerMenu({
      menuID: "zbp-settings", pluginID: id, target:"main/menubar/tools",
      menus:[{menuType:"menuitem",l10nID:"zbp-settings",onCommand:()=>this.open(null,true)}]
    }));
    if(this.menuIDs.some(id=>!id))throw new Error("无法注册双语 PDF 菜单。");
  },
  addToWindow(win) { win.MozXULElement?.insertFTLIfNeeded("zbp.ftl"); },
  alert(e) { Services.prompt.alert(Zotero.getMainWindow(), "双语 PDF", e.message || String(e)); },
  async resolvePDF(items) {
    for (let item of items || []) {
      if (item.isRegularItem()) {
        const atts = Zotero.Items.get(item.getAttachments());
        item = atts.find(a => a.attachmentContentType === "application/pdf" && !a.getField("title").startsWith("中文译版 ·"));
      }
      if (item?.isAttachment() && item.attachmentContentType === "application/pdf") {
        if(item.getField("title").startsWith("中文译版 ·")) {
          const original=(item.relatedItems||[]).map(key=>Zotero.Items.getByLibraryAndKey(item.libraryID,key))
            .find(a=>a?.isAttachment() && a.attachmentContentType==="application/pdf" && !a.getField("title").startsWith("中文译版 ·"));
          if(original)return original;
        }
        return item;
      }
    }
    throw new Error("请先选中一篇带 PDF 的文献，或直接选中 PDF 附件。");
  },
  async openSelection(items) { return this.open(await this.resolvePDF(items)); },
  open(item, settings = false) {
    const display=Zotero.getMainWindow().screen;
    const width=Math.max(320,Math.min(1280,(display.availWidth||display.width)-48));
    const height=Math.max(300,Math.min(760,(display.availHeight||display.height)-96));
    const win = Zotero.getMainWindow().openDialog("chrome://zbp/content/reader.xhtml", "", `chrome,dialog=no,centerscreen,resizable,minimizable,titlebar,close,width=${width},height=${height}`,
      {bridge:this, item, settings});
    this.windows.add(win);
    win.addEventListener("unload",event=>{
      if(event.target?.documentURI==="chrome://zbp/content/reader.xhtml")this.windows.delete(win);
    });
    return win;
  },
  getSettings() {
    const get = (key, fallback) => Zotero.Prefs.get(this.pref + key, true) || fallback;
    return {engine:get("engine","hybrid"),baseURL:get("baseURL","https://api.deepseek.com"),model:get("model","deepseek-flash"),outputDir:get("outputDir",this.defaultRoot),structureAssist:Zotero.Prefs.get(this.pref+"structureAssist",true)!==false};
  },
  async readPDFFonts() {
    const windowsDir = Services.env.get("WINDIR") || Services.env.get("SystemRoot");
    if (!windowsDir) throw new Error("无法定位 Windows 字体目录。");
    const dir = PathUtils.join(windowsDir, "Fonts");
    let fonts;
    try{fonts={song:await IOUtils.read(dir+"\\simsun.ttc"),times:await IOUtils.read(dir+"\\times.ttf"),fallbacks:[]};}
    catch(e){throw new Error("无法读取本机宋体或 Times New Roman，请确认 Windows 字体已安装。译文缓存已保留。");}
    for(const [name,index] of [["cambria.ttc",1],["seguisym.ttf",0],["seguiemj.ttf",0],["simsunb.ttf",0],["SimsunExtG.ttf",0]]){
      try{fonts.fallbacks.push({name,index,bytes:await IOUtils.read(PathUtils.join(dir,name))});}catch(_){}
    }
    let extra=[];try{extra=JSON.parse(Zotero.Prefs.get(this.pref+"supplementFonts",true)||"[]");}catch(_){}
    for(const path of extra)try{
      const bytes=await IOUtils.read(path),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const count=v.getUint32(0)===0x74746366?Math.min(16,v.getUint32(8)):1;
      for(let index=0;index<count;index++)fonts.fallbacks.push({name:"User supplement",index,bytes});
    }catch(_){}
    return fonts;
  },
  async getKey() {
    if (this.sessionKey) return this.sessionKey;
    try {
      const logins = await Services.logins.findLogins("chrome://zbp", null, "DeepSeek API");
      return logins[0]?.password || "";
    } catch (_) { return ""; }
  },
  async saveSettings(settings, key, remember) {
    const url = new URL(settings.baseURL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("API 地址须为 HTTPS 地址，不能带账号、查询参数或片段。");
    if (!settings.model.trim()) throw new Error("请填写模型名称。");
    await IOUtils.makeDirectory(settings.outputDir,{ignoreExisting:true,createAncestors:true});
    for (const name of ["baseURL","model","outputDir"]) Zotero.Prefs.set(this.pref + name,settings[name].trim(),true);
    Zotero.Prefs.set(this.pref+"structureAssist",settings.structureAssist!==false,true);
    Zotero.Prefs.set(this.pref+"engine",settings.engine==="legacy"?"legacy":"hybrid",true);
    this.sessionKey = key.trim();
    let stored = false;
    try {
      const old = await Services.logins.findLogins("chrome://zbp",null,"DeepSeek API");
      for (const login of old) Services.logins.removeLogin(login);
      if (remember && this.sessionKey) {
        const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
        login.init("chrome://zbp",null,"DeepSeek API","api",this.sessionKey,"","");
        await Services.logins.addLoginAsync(login); stored = true;
      }
    } catch (_) { /* The UI reports session-only storage. */ }
    return stored;
  },
  async chooseDirectory(win) {
    const {FilePicker} = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker(); picker.init(win,"选择译版保存文件夹",picker.modeGetFolder);
    return await picker.show() === picker.returnOK ? picker.file : null;
  },
  async chooseSupplementFont(win) {
    const {FilePicker}=ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker=new FilePicker();picker.init(win,"选择本机补充字体（TTF、OTF 或 TTC）",picker.modeOpen);
    if(await picker.show()!==picker.returnOK)return null;
    const path=picker.file;if(!/\.(?:ttf|otf|ttc)$/i.test(path))throw new Error("请选择 TTF、OTF 或 TTC 字体文件。");
    if((await IOUtils.stat(path)).size>128*1024*1024)throw new Error("补充字体超过128MB，请选择较小的静态字体。");
    return {path,bytes:await IOUtils.read(path)};
  },
  addSupplementFont(path) {
    let paths=[];try{paths=JSON.parse(Zotero.Prefs.get(this.pref+"supplementFonts",true)||"[]");}catch(_){}
    if(!paths.includes(path))paths.push(path);Zotero.Prefs.set(this.pref+"supplementFonts",JSON.stringify(paths),true);
  },
  async source(item) {
    const path = await item.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) throw new Error("找不到原 PDF，请先在 Zotero 中定位文件。");
    const attachmentTitle=item.getField("title"),parent=item.parentID?Zotero.Items.get(item.parentID):null;
    const generic=/^(?:Full[ -]?Text(?: PDF)?|PDF|正文)$/i.test(attachmentTitle.trim());
    const title=(generic&&parent?.isRegularItem()?parent.getField("title"):attachmentTitle).replace(/<[^>]+>/g,"");
    return {path, bytes:await IOUtils.read(path), key:item.libraryID + "-" + item.key, title};
  },
  async json(path) {
    try {return JSON.parse(await IOUtils.readUTF8(path));}
    catch(e) { if (e.name === "NotFoundError") return null; throw new Error("缓存无法读取，请在设置中选择新的保存文件夹。"); }
  },
  async writeJSON(path,value) {
    await IOUtils.writeUTF8(path,JSON.stringify(value,null,2),{tmpPath:path+".tmp"});
  },
  async paths(key) {
    const root = this.getSettings().outputDir;
    await IOUtils.makeDirectory(root,{ignoreExisting:true,createAncestors:true});
    const dir = PathUtils.join(root,".bilingual-cache");
    await IOUtils.makeDirectory(dir,{ignoreExisting:true,createAncestors:true});
    return {root,dir,index:PathUtils.join(dir,key+".json")};
  },
  async writePDF(path,bytes) {
    if (await IOUtils.exists(path)) throw new Error("目标文件已存在；为保护已有译版，本次未覆盖。");
    await IOUtils.write(path,bytes,{tmpPath:path+".tmp",noOverwrite:true});
  },
  async attach(item,path) {
    const attachments = item.parentID ? Zotero.Items.get(Zotero.Items.get(item.parentID).getAttachments()) : [];
    for (const a of attachments) if (a.isAttachment() && await a.getFilePathAsync() === path) return a;
    const title = "中文译版 · " + item.getField("title");
    if (item.libraryID !== Zotero.Libraries.userLibraryID)
      return null; // Zotero group libraries do not allow linked files.
    const linked = await Zotero.Attachments.linkFromFile({
      file:path,title,contentType:"application/pdf",
      ...(item.parentID ? {parentItemID:item.parentID} : {collections:item.getCollections()})
    });
    linked.addRelatedItem(item);await linked.saveTx();
    return linked;
  },
  async native(item) { await Zotero.Reader.open(item.id); },
  reveal(path) { Zotero.File.reveal(path); },
  async shutdown() {
    this.engine.shutdown();
    for(const win of this.windows) if(!win.closed) win.close();
    this.windows.clear(); this.sessionKey = "";
    for(const id of this.menuIDs||[])if(id)Zotero.MenuManager.unregisterMenu(id);
    this.menuIDs=[];
  }
};
