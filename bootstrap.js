var rootURI;
var windowListener;
var chromeHandle;

function log(msg) {
  Zotero.debug("[SmartReadAloud] " + msg);
}

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI: _rootURI }) {
  rootURI = _rootURI;
  log("v" + version + " starting");

  try {
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "smart-read-aloud", "content/"]
    ]);
  } catch (e) {
    log("registerChrome failed: " + e);
  }

  for (const win of Zotero.getMainWindows()) addMenuToWindow(win);

  windowListener = {
    onOpenWindow(xulWin) {
      const domWin = xulWin.docShell.domWindow;
      domWin.addEventListener("load", () => {
        if (domWin.Zotero && domWin.ZoteroPane) addMenuToWindow(domWin);
      }, { once: true });
    },
    onCloseWindow() {},
    onWindowTitleChange() {}
  };
  Services.wm.addListener(windowListener);
}

function shutdown() {
  if (windowListener) {
    Services.wm.removeListener(windowListener);
    windowListener = null;
  }
  for (const win of Zotero.getMainWindows()) removeMenuFromWindow(win);
  if (chromeHandle) {
    try { chromeHandle.destruct(); } catch (e) {}
    chromeHandle = null;
  }
}

function addMenuToWindow(win) {
  const doc = win.document;
  if (doc.getElementById("zra-menuitem")) return;
  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (!toolsPopup) return;

  const item = doc.createXULElement("menuitem");
  item.id = "zra-menuitem";
  item.setAttribute("label", "Smart Read Aloud…");
  item.addEventListener("command", () => openDialog(win));
  toolsPopup.appendChild(item);
}

function removeMenuFromWindow(win) {
  const item = win.document.getElementById("zra-menuitem");
  if (item) item.remove();
}

function openDialog(win) {
  win.openDialog(
    "chrome://smart-read-aloud/content/reader.xhtml",
    "zra-dialog",
    "chrome,centerscreen,resizable,width=820,height=720",
    Zotero
  );
}
