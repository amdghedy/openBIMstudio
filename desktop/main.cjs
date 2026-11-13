"use strict";
const { app, BrowserWindow, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = "127.0.0.1";
const MIME = {
  ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",
  ".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",".wasm":"application/wasm",
  ".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",
  ".webp":"image/webp",".ico":"image/x-icon",".woff":"font/woff",".woff2":"font/woff2",
  ".ttf":"font/ttf",".glb":"model/gltf-binary",".gltf":"model/gltf+json",
  ".bin":"application/octet-stream",".pdf":"application/pdf",".txt":"text/plain; charset=utf-8"
};
let localServer;
let localOrigin;
let mainWindow;

function distributionDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-dist")
    : path.resolve(__dirname, "..", "dist");
}
function headers() {
  return {
    "Cross-Origin-Opener-Policy":"same-origin",
    "Cross-Origin-Embedder-Policy":"require-corp",
    "Cross-Origin-Resource-Policy":"same-origin",
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer",
    "Permissions-Policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy":"object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  };
}
function safeFile(root, requestUrl) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(requestUrl, localOrigin || "http://127.0.0.1").pathname); }
  catch { return null; }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const candidate = path.resolve(root, pathname.replace(/^\/+/, "") || "index.html");
  const relative = path.relative(root, candidate);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : candidate;
}
function createStaticServer() {
  const root = distributionDirectory();
  if (!fs.existsSync(path.join(root, "index.html"))) {
    throw new Error("Production build not found. Run npm run build before launching the desktop app.");
  }
  return http.createServer((req, res) => {
    const h = headers();
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { ...h, Allow:"GET, HEAD" }); return res.end();
    }
    const file = safeFile(root, req.url || "/");
    if (!file) { res.writeHead(400, h); return res.end("Bad request"); }
    const sendFile = target => fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404, h); return res.end("Not found"); }
      res.writeHead(200, {
        ...h,
        "Content-Type":MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Content-Length":stat.size,
        "Cache-Control":target.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable"
      });
      if (method === "HEAD") return res.end();
      const stream = fs.createReadStream(target);
      stream.on("error", () => { if (!res.headersSent) res.writeHead(500, h); res.end(); });
      stream.pipe(res);
    });
    fs.stat(file, (err, stat) => {
      if (!err && stat.isDirectory()) return sendFile(path.join(file, "index.html"));
      if (!err && stat.isFile()) return sendFile(file);
      let hasExtension = true;
      try { hasExtension = !!path.extname(new URL(req.url || "/", "http://localhost").pathname); } catch {}
      if (!hasExtension) return sendFile(path.join(root, "index.html"));
      res.writeHead(404, h); res.end("Not found");
    });
  });
}
async function startLocalServer() {
  localServer = createStaticServer();
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, HOST, () => {
      localServer.removeListener("error", reject);
      localOrigin = "http://" + HOST + ":" + localServer.address().port;
      resolve();
    });
  });
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width:1600, height:1000, minWidth:960, minHeight:640, show:false,
    autoHideMenuBar:true, backgroundColor:"#f5f7fb",
    webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url).catch(() => {});
    return { action:"deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(localOrigin)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadURL(localOrigin);
}
app.whenReady().then(async () => {
  try {
    await startLocalServer();
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    console.error("[OpenBIMStudio] Startup failed:", error);
    app.quit();
  }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (localServer) { localServer.close(); localServer = null; }
});
