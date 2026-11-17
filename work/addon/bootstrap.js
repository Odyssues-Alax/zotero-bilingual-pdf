var ZBP, chromeHandle;
async function startup({id, rootURI}) {
  await Zotero.initializationPromise;
  chromeHandle = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup)
    .registerChrome(Services.io.newURI(rootURI + "manifest.json"), [["content", "zbp", rootURI + "content/"]]);
  Services.scriptloader.loadSubScript(rootURI + "native-engine.js");
  Services.scriptloader.loadSubScript(rootURI + "bridge.js");
  ZBP = ZBPBridge; Zotero.BilingualPDF = ZBP;
  await ZBP.startup(id, rootURI);
}
async function shutdown() {
  await ZBP?.shutdown(); delete Zotero.BilingualPDF; ZBP = null;
  chromeHandle?.destruct(); chromeHandle = null;
}
function onMainWindowLoad({window}) { ZBP?.addToWindow(window); }
function onMainWindowUnload() {}
function install() {}
function uninstall() {}
