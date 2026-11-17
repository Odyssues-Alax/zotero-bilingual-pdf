// Managed child processes. Secrets are sent through stdin, never command arguments/files.
var ZBPEngine={
 version:'0.6.4-adapter2',processes:new Set(),installPromise:null,
 // Package resources are local jar:file URLs, not HTTP URLs. Zotero 10's
 // HTTP parser reads username/password URI fields that jar URIs do not expose.
 readPackageText(uri){
  if(!/^(?:jar:file:|file:|chrome:|resource:)/.test(uri))throw new Error("引擎资源必须来自本机插件包。");
  return new Promise((resolve,reject)=>{
   const xhr=new (Zotero.getMainWindow().XMLHttpRequest)();
   xhr.open("GET",uri,true);xhr.responseType="text";xhr.overrideMimeType("text/plain; charset=utf-8");xhr.timeout=30000;
   xhr.onload=()=>{if(xhr.status===0||xhr.status===200)resolve(xhr.responseText.replace(/^\uFEFF/,""));else reject(new Error("无法读取本机引擎资源（"+xhr.status+"）。"));};
   xhr.onerror=()=>reject(new Error("无法读取插件内置引擎资源。"));xhr.ontimeout=()=>reject(new Error("读取插件内置引擎资源超时。"));xhr.send();
  });
 },
 async paths(bridge){
  const root=PathUtils.join(bridge.profileRoot,"engine-runtime");
  const scripts=PathUtils.join(root,"adapter");await IOUtils.makeDirectory(scripts,{ignoreExisting:true,createAncestors:true});
  for(const name of ["worker.py","install.ps1","requirements.txt"]){
   const text=await this.readPackageText(bridge.rootURI+"engine/"+name);
   if(typeof text!=="string"||text.startsWith("[object "))throw new Error("无法读取引擎安装资源。");
   const path=PathUtils.join(scripts,name);
   if(name.endsWith(".ps1")||!await IOUtils.exists(path)||await IOUtils.readUTF8(path)!==text)await IOUtils.writeUTF8(path,name.endsWith(".ps1")?"\uFEFF"+text:text,{tmpPath:path+".tmp"});
  }
  return {root,scripts,python:PathUtils.join(root,"venv-managed","Scripts","python.exe"),worker:PathUtils.join(scripts,"worker.py"),installer:PathUtils.join(scripts,"install.ps1")};
 },
 async run(command,args,input,{signal,onProgress=()=>{},workdir,timeout=25*60*1000}={}){
  if(signal?.aborted)throw new DOMException("已取消","AbortError");
  const {Subprocess}=ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const proc=await Subprocess.call({command,arguments:args,workdir,stderr:"pipe",environmentAppend:true,environment:{PYTHONIOENCODING:"utf-8",PYTHONUNBUFFERED:"1",PYTHONDONTWRITEBYTECODE:"1"}});
  this.processes.add(proc);let result=null,error=null,buffer="",stderrTail="",timedOut=false;
  const win=Zotero.getMainWindow(),timer=win.setTimeout(()=>{timedOut=true;proc.kill();},timeout);
  const abort=()=>proc.kill();signal?.addEventListener("abort",abort,{once:true});
  const stderr=(async()=>{for(;;){const chunk=await proc.stderr.readString();if(!chunk)break;stderrTail=(stderrTail+chunk).slice(-1800);};})();
  const output=(async()=>{for(;;){const chunk=await proc.stdout.readString();if(!chunk)break;buffer+=chunk;if(buffer.length>8*1024*1024)throw new Error("引擎输出异常。");let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);let e;try{e=JSON.parse(line);}catch(_){continue;}if(e.type==="result")result=e;else if(e.type==="error")error=e.message;else if(e.type==="progress")onProgress(e);}}})();
  try{
   if(input)await proc.stdin.write(JSON.stringify(input)+"\n");await proc.stdin.close();
   await output;const exit=await proc.wait();await stderr;
   if(signal?.aborted)throw new DOMException("已取消；已完成译文保留，下次继续。","AbortError");
   if(timedOut)throw new Error("本机处理超时；断点已保留，可重新生成。");
   if(exit.exitCode!==0||error||!result)throw new Error(error||("本机引擎退出（"+exit.exitCode+"）："+(input?.key?stderrTail.split(input.key).join("[credential]"):stderrTail).slice(-900)||"未收到结果"));
   return result;
  }finally{win.clearTimeout(timer);signal?.removeEventListener("abort",abort);if(proc.exitCode==null)await proc.kill();this.processes.delete(proc);}
 },
 async status(bridge){const p=await this.paths(bridge);if(!await IOUtils.exists(p.python))return {ready:false};try{return await this.run(p.python,["-u",p.worker],{action:"status",root:p.root},{workdir:p.root,timeout:30000});}catch(e){return {ready:false,error:JSON.stringify(e,Object.getOwnPropertyNames(e))};}},
 async install(bridge,onProgress=()=>{}){
  if(this.installPromise)return this.installPromise;
  this.installPromise=(async()=>{
   const p=await this.paths(bridge),ps=PathUtils.join(Services.env.get("WINDIR")||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
   await this.run(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",p.installer,"-Root",p.root],null,{onProgress,workdir:p.root,timeout:30*60*1000});
   const prepared=await this.run(p.python,["-u",p.worker],{action:"prepare",root:p.root},{onProgress,workdir:p.root,timeout:15*60*1000});
   await bridge.writeJSON(PathUtils.join(p.root,"ready.json"),{version:this.version,prepared:new Date().toISOString()});return prepared;
  })().finally(()=>{this.installPromise=null;});return this.installPromise;
 },
 async layout(bridge,source,paths,{signal,onProgress=()=>{}}={}){
  const p=await this.paths(bridge);if(!await IOUtils.exists(p.python))throw new Error("请在设置中安装本机版面引擎，再重新打开论文。");
  const cache=PathUtils.join(paths.dir,source.key+"-"+source.hash.slice(0,12)+"-model-layout1.json");
  return this.run(p.python,["-u",p.worker],{action:"layout",root:p.root,source:source.path,sourceHash:source.hash,cache},{signal,onProgress,workdir:p.root,timeout:15*60*1000});
 },
 async generate(bridge,source,paths,{signal,onProgress=()=>{},pages,action="translate",retry=false,overrides=[]}={}){
  const p=await this.paths(bridge);
  if(!await IOUtils.exists(p.python))throw new Error("请先在设置中安装本机 PDF 引擎。");
  const job=PathUtils.join(p.root,"jobs",source.key+"-"+Date.now());await IOUtils.makeDirectory(job,{ignoreExisting:true,createAncestors:true});
  const settings=bridge.getSettings(),identity=Zotero.Utilities.Internal.md5(settings.baseURL+"|"+settings.model).slice(0,12),cache=PathUtils.join(paths.dir,source.key+"-"+source.hash.slice(0,12)+"-babeldoc2-"+identity+".json");
  let supplementFonts=[];try{supplementFonts=JSON.parse(Zotero.Prefs.get(bridge.pref+"supplementFonts",true)||"[]");}catch(_){}
  const request={action,root:p.root,source:source.path,sourceHash:source.hash,job,cache,pages,baseURL:settings.baseURL,model:settings.model,key:action==="translate"?await bridge.getKey():"",supplementFonts,retry,overrides};
  if(action==="translate"&&!request.key)throw new Error("请先在设置中填写 API Key。");
  try{return await this.run(p.python,["-u",p.worker],request,{signal,onProgress,workdir:p.root});}catch(e){e.nativeRegionsPath=PathUtils.join(job,"regions.json");e.nativeCachePath=cache;throw e;}finally{request.key="";}
 },
 shutdown(){for(const p of this.processes)p.kill();this.processes.clear();}
};
