const { app, BrowserWindow, shell, Menu, nativeTheme, dialog, ipcMain, nativeImage, globalShortcut } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const https = require('https')
const fs   = require('fs')
const crypto = require('crypto')

// Set a stable AUMID immediately — must happen before app is ready.
app.setAppUserModelId('com.afterspace.chat')

// ── Firebase / update URLs ────────────────────────────────────────────────────
const FIREBASE_DB   = 'https://as-superchat-default-rtdb.firebaseio.com'
const HTML_UPD_URL  = `${FIREBASE_DB}/htmlUpdate.json`
const GITHUB_RELEASE_URL = 'https://api.github.com/repos/V3RT1G06/Afterspace-Publisher/releases/latest'
const UPDATER_USER_AGENT = 'Afterspace-Updater/8.0.1'

// ── Helpers ───────────────────────────────────────────────────────────────────
function isNewer(remote, local) {
  const r = String(remote).split('.').map(Number)
  const l = String(local).split('.').map(Number)
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true
    if ((r[i] || 0) < (l[i] || 0)) return false
  }
  return false
}

function fetchJSON(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': UPDATER_USER_AGENT, Accept: 'application/vnd.github+json' },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume()
        fetchJSON(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('request timeout')))
  })
}

function downloadToFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    const cleanup = err => {
      file.destroy()
      fs.unlink(destPath, () => {})
      reject(err)
    }
    const req = https.get(url, {
      timeout: 60000,
      headers: { 'User-Agent': UPDATER_USER_AGENT },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        file.destroy()
        fs.unlink(destPath, () => {})
        downloadToFile(new URL(res.headers.location, url).toString(), destPath, redirects + 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        cleanup(new Error(`HTTP ${res.statusCode}`))
        return
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', cleanup)
    })
    req.on('error', cleanup)
    req.on('timeout', () => req.destroy(new Error('download timeout')))
  })
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

// ── HTML cache paths ──────────────────────────────────────────────────────────
const cachedHtmlPath = () => path.join(app.getPath('userData'), 'app-cached.html')
const cachedVerPath  = () => path.join(app.getPath('userData'), 'html-version.txt')

function getCachedHtmlVersion() {
  try { return fs.readFileSync(cachedVerPath(), 'utf8').trim() } catch { return null }
}

function getHtmlPath() {
  const cached = cachedHtmlPath()
  if (fs.existsSync(cached)) {
    try {
      const head = fs.readFileSync(cached, 'utf8').slice(0, 12000)
      if (/<!doctype html/i.test(head) && /Afterspace/i.test(head)) return cached
    } catch {}
  }
  return path.join(__dirname, 'app', 'Afterspace V8.html')
}

// ── HTML content auto-updater ─────────────────────────────────────────────────
async function checkForHtmlUpdate(win) {
  try {
    const info = await fetchJSON(HTML_UPD_URL)
    if (!info || info.error || !info.version || !info.url) return

    const currentVer = getCachedHtmlVersion()
    if (info.version === currentVer) return      // already on this version

    const tmpPath = cachedHtmlPath() + '.tmp'
    await downloadToFile(info.url, tmpPath)

    const htmlHead = fs.readFileSync(tmpPath, 'utf8').slice(0, 12000)
    if (!/<!doctype html/i.test(htmlHead) || !/Afterspace/i.test(htmlHead)) {
      fs.unlinkSync(tmpPath)
      throw new Error('Downloaded update is not a valid Afterspace HTML file')
    }
    if (info.sha256 && sha256(tmpPath).toLowerCase() !== String(info.sha256).toLowerCase()) {
      fs.unlinkSync(tmpPath)
      throw new Error('Downloaded HTML checksum did not match')
    }

    if (fs.existsSync(cachedHtmlPath())) fs.rmSync(cachedHtmlPath(), { force: true })
    fs.renameSync(tmpPath, cachedHtmlPath())
    fs.writeFileSync(cachedVerPath(), String(info.version), 'utf8')

    const detail = info.notes
      ? `What's new:\n${info.notes}\n\nClick Restart to apply.`
      : 'Click Restart to apply the update.'

    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'App Updated',
      message: `Afterspace has been updated to v${info.version}`,
      detail,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0, cancelId: 1,
    })

    if (response === 0) { app.relaunch(); app.exit(0) }
  } catch (_) {
    // Silent — never interrupt the user over an update failure
  }
}

// ── Electron exe auto-updater ─────────────────────────────────────────────────
let exeUpdateInProgress = false

function updaterHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'auto-update.ps1')
    : path.join(__dirname, 'auto-update.ps1')
}

async function checkForUpdates(win, silent = true) {
  if (exeUpdateInProgress) return
  try {
    const release = await fetchJSON(GITHUB_RELEASE_URL)
    const latestVersion = String(release && release.tag_name || '').replace(/^v/i, '')
    const exeAsset = Array.isArray(release && release.assets)
      ? release.assets.find(asset => asset && asset.name === 'Afterspace.exe')
      : null
    if (!latestVersion) {
      if (!silent) dialog.showMessageBox(win, { type: 'info', title: 'Up to Date', message: `You're on the latest version (${app.getVersion()}).`, buttons: ['OK'] })
      return
    }
    if (isNewer(latestVersion, app.getVersion())) {
      if (!app.isPackaged || process.platform !== 'win32' || !process.env.PORTABLE_EXECUTABLE_FILE) {
        if (!silent) {
          await dialog.showMessageBox(win, {
            type: 'info', title: 'Update Available',
            message: `Afterspace ${latestVersion} is available`,
            detail: 'Automatic replacement is available in the portable Windows build.',
            buttons: ['Open Download Page', 'Later'], defaultId: 0, cancelId: 1,
          }).then(({ response }) => response === 0 && shell.openExternal(release.html_url))
        }
        return
      }
      if (!exeAsset || !exeAsset.browser_download_url) throw new Error('Release is missing Afterspace.exe')
      const digestMatch = /^sha256:([a-f0-9]{64})$/i.exec(String(exeAsset.digest || ''))
      if (!digestMatch) throw new Error('Release is missing its GitHub SHA-256 digest')

      exeUpdateInProgress = true
      if (win && !win.isDestroyed()) win.setProgressBar(2)
      const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'AfterspaceUpdate-'))
      const stagedExe = path.join(tempDir, 'Afterspace.exe')
      await downloadToFile(exeAsset.browser_download_url, stagedExe)
      if (fs.statSync(stagedExe).size < 10 * 1024 * 1024) throw new Error('Downloaded EXE is unexpectedly small')
      const expectedHash = digestMatch[1].toLowerCase()
      if (sha256(stagedExe).toLowerCase() !== expectedHash) throw new Error('Downloaded EXE failed SHA-256 verification')

      const helper = updaterHelperPath()
      if (!fs.existsSync(helper)) throw new Error('Automatic update helper is missing')
      const currentExe = process.env.PORTABLE_EXECUTABLE_FILE
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', helper,
        '-CurrentExe', currentExe,
        '-StagedExe', stagedExe,
        '-ExpectedHash', expectedHash,
        '-ExpectedVersion', latestVersion,
        '-ParentPid', String(process.pid),
      ], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()

      await dialog.showMessageBox(win, {
        type: 'info', title: 'Installing Update',
        message: `Afterspace ${latestVersion} is ready`,
        detail: 'Afterspace will close, replace itself with the verified update, and restart automatically.',
        buttons: ['Continue'],
      })
      app.quit()
    } else if (!silent) {
      dialog.showMessageBox(win, { type: 'info', title: 'Up to Date', message: `You're on the latest version (${app.getVersion()}).`, buttons: ['OK'] })
    }
  } catch (error) {
    exeUpdateInProgress = false
    if (win && !win.isDestroyed()) win.setProgressBar(-1)
    if (!silent) dialog.showMessageBox(win, { type: 'warning', title: 'Update Check Failed', message: 'The automatic update could not be completed.', detail: error.message, buttons: ['OK'] })
  }
}

// ── Custom titlebar ───────────────────────────────────────────────────────────
// Injected after dom-ready via insertCSS + executeJavaScript so the HTML file
// is never modified. The logo is borrowed from #serverHomeBtn which is already
// in the page, so no filesystem access is needed.

const TB_H = 32   // px

const TB_CSS = `
#nu-titlebar {
  position: fixed; top: 0; left: 0; right: 0;
  height: ${TB_H}px;
  z-index: 2147483647;
  -webkit-app-region: drag;
  display: flex; align-items: center;
  background: #000;
  border-bottom: 1px solid rgba(255,255,255,.06);
  user-select: none; box-sizing: border-box;
  font-family: 'Nova Cut', cursive;
}
#nu-tb-logo {
  width: 22px; height: 22px; border-radius: 7px;
  margin-left: 12px; object-fit: cover;
  flex-shrink: 0; pointer-events: none;
}
#nu-tb-badge {
  width: 22px; height: 22px; border-radius: 7px;
  background: linear-gradient(135deg,#5865f2,#7b4fe8);
  display: flex; align-items: center; justify-content: center;
  font-size: 8px; color: #fff;
  font-family: 'Nova Cut', cursive;
  margin-left: 12px; flex-shrink: 0; pointer-events: none;
  letter-spacing: .05em;
}
#nu-tb-name {
  margin-left: 9px;
  font-family: 'Nova Cut', cursive;
  font-size: 13px;
  color: rgba(255,255,255,.55);
  letter-spacing: .1em;
  flex: 1; pointer-events: none; white-space: nowrap; overflow: hidden;
}
.nu-win-btn {
  -webkit-app-region: no-drag;
  width: 46px; height: ${TB_H}px;
  border: none !important;
  background: transparent !important;
  border-radius: 0 !important;
  color: rgba(255,255,255,.4); font-size: 13px; line-height: 1;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background .12s, color .12s;
  padding: 0; flex-shrink: 0;
  outline: none !important; box-shadow: none !important;
}
.nu-win-btn:hover            { background: rgba(255,255,255,.07) !important; border-radius: 0 !important; color: rgba(255,255,255,.85); }
.nu-win-btn.nu-close:hover   { background: rgba(192,57,43,.75) !important;  border-radius: 0 !important; color: #fff; }
#nuScaleWrapper {
  margin-top: ${TB_H}px !important;
  height: calc(100dvh - ${TB_H}px) !important;
  max-height: calc(100dvh - ${TB_H}px) !important;
}
`

const TB_JS = `(function(){
  if (document.getElementById('nu-titlebar')) return;
  var bar = document.createElement('div');
  bar.id = 'nu-titlebar';

  // Reuse the logo already embedded in the page
  var srcEl = document.querySelector('#serverHomeBtn img');
  if (srcEl && srcEl.src) {
    var img = document.createElement('img');
    img.id = 'nu-tb-logo'; img.src = srcEl.src; img.alt = 'AS';
    bar.appendChild(img);
  } else {
    var badge = document.createElement('div');
    badge.id = 'nu-tb-badge'; badge.textContent = 'AS';
    bar.appendChild(badge);
  }

  var nm = document.createElement('span');
  nm.id = 'nu-tb-name'; nm.textContent = 'Afterspace';
  bar.appendChild(nm);

  function mkBtn(html, cls, action) {
    var b = document.createElement('button');
    b.className = 'nu-win-btn' + (cls ? ' ' + cls : '');
    b.innerHTML = html;
    b.addEventListener('click', function() {
      if (window.__desktop__ && typeof window.__desktop__[action] === 'function')
        window.__desktop__[action]();
    });
    return b;
  }
  bar.appendChild(mkBtn('&#8722;', '',         'minimize'));
  bar.appendChild(mkBtn('&#9633;', '',         'maximize'));
  bar.appendChild(mkBtn('&#215;', 'nu-close', 'close'));

  if (document.body) document.body.insertBefore(bar, document.body.firstChild);
})()`

// ── Admin updater window ──────────────────────────────────────────────────────
// Opened with webSecurity:false so Firebase Storage XHR isn't blocked by CORS.
// The admin-updater.html is opened as a file:// URL which would otherwise get
// origin:null, causing every Firebase Storage preflight to fail.
let adminWindow

function createAdminWindow() {
  try {
    if (adminWindow && !adminWindow.isDestroyed()) {
      adminWindow.focus()
      return
    }
    adminWindow = new BrowserWindow({
      width: 560,
      height: 700,
      minWidth: 480,
      minHeight: 540,
      title: 'Afterspace Admin Updater',
      backgroundColor: '#0d0d0d',
      autoHideMenuBar: true,
      webPreferences: {
        // webSecurity:false removes the browser's CORS enforcement in this window.
        // Firebase Storage XHR calls then go out without a preflight origin check,
        // so uploads work from the local HTML file.
        webSecurity: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    // When packaged, extraResources places admin-updater.html in process.resourcesPath
    // (alongside the asar). In dev mode __dirname is the project root — same place.
    const adminHtml = app.isPackaged
      ? path.join(process.resourcesPath, 'admin-updater.html')
      : path.join(__dirname, 'admin-updater.html')

    if (!fs.existsSync(adminHtml)) {
      dialog.showMessageBox(mainWindow || null, {
        type: 'warning', title: 'Admin Updater',
        message: 'admin-updater.html not found at:\n' + adminHtml,
        detail: 'Make sure you are using the Admin build (the ZIP that includes admin-updater.html).',
        buttons: ['OK'],
      })
      adminWindow.destroy()
      adminWindow = null
      return
    }

    adminWindow.loadFile(adminHtml)
    adminWindow.on('closed', () => { adminWindow = null })
  } catch (err) {
    if (adminWindow && !adminWindow.isDestroyed()) { adminWindow.destroy(); adminWindow = null }
    dialog.showMessageBox(mainWindow || null, {
      type: 'error', title: 'Admin Updater Error',
      message: 'Failed to open the Admin Updater.',
      detail: err.message,
      buttons: ['OK'],
    })
  }
}

// ── Window creation ───────────────────────────────────────────────────────────
let mainWindow

function createWindow() {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 550,
    title: 'Afterspace',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#0d0d0d',
    titleBarStyle: 'hidden',   // hides native chrome, keeps resize borders
    autoHideMenuBar: true,     // Alt still reveals App / View menus
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
    show: false,
  })

  mainWindow.loadFile(getHtmlPath())

  // Portable-exe taskbar pin support
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
  if (portableExe) {
    mainWindow.setAppDetails({
      appId: 'com.afterspace.chat',
      relaunchCommand: `"${portableExe}"`,
      relaunchDisplayName: 'Afterspace',
    })
  }

  // Inject the custom titlebar once the DOM is parsed
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.insertCSS(TB_CSS).catch(() => {})
    mainWindow.webContents.executeJavaScript(TB_JS).catch(() => {})
  })

  // Show window after first paint (no white flash)
  let _shown = false
  const _show = () => {
    if (_shown || !mainWindow) return
    _shown = true
    mainWindow.show()
    mainWindow.focus()
    // HTML content update (silent) — 5 s after launch
    setTimeout(() => checkForHtmlUpdate(mainWindow), 5000)
    // Exe update (silent) — 8 s after launch
    setTimeout(() => checkForUpdates(mainWindow, true), 8000)
  }
  mainWindow.once('ready-to-show', _show)
  setTimeout(_show, 6000)

  // External links open in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── App menu (keyboard shortcuts still work when bar is hidden) ───────────────
function buildMenu() {
  const template = [
    {
      label: 'App',
      submenu: [
        { label: 'Check for Updates', click: () => mainWindow && checkForUpdates(mainWindow, false) },
        { type: 'separator' },
        { label: 'Reload',        accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.webContents.reload() },
        { label: 'Toggle DevTools', accelerator: 'F12',       click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Admin Updater', accelerator: 'CmdOrCtrl+Shift+A', click: () => createAdminWindow() },
        { type: 'separator' },
        { label: 'Quit', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In',    accelerator: 'CmdOrCtrl+=', click: () => { if (mainWindow) { const z = mainWindow.webContents.getZoomFactor(); mainWindow.webContents.setZoomFactor(Math.min(z + 0.1, 3)) } } },
        { label: 'Zoom Out',   accelerator: 'CmdOrCtrl+-', click: () => { if (mainWindow) { const z = mainWindow.webContents.getZoomFactor(); mainWindow.webContents.setZoomFactor(Math.max(z - 0.1, 0.5)) } } },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWindow && mainWindow.webContents.setZoomFactor(1) },
        { type: 'separator' },
        { label: 'Full Screen', accelerator: 'F11', click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── IPC: titlebar window controls ─────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize())
ipcMain.on('win-maximize', () => mainWindow && (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()))
ipcMain.on('win-close',    () => mainWindow && mainWindow.close())

// ── IPC: DM taskbar badge ─────────────────────────────────────────────────────
// Draws a 16×16 red circle in the renderer via canvas, converts to nativeImage,
// and sets it as a taskbar overlay icon (Windows) so users see the red dot even
// when the window is minimised or behind other apps.

let _redDotImg = null   // cached once generated

async function getRedDotImg() {
  if (_redDotImg) return _redDotImg
  if (!mainWindow) return null
  try {
    const dataUrl = await mainWindow.webContents.executeJavaScript(`(function(){
      const c = document.createElement('canvas'); c.width = 16; c.height = 16;
      const x = c.getContext('2d');
      x.beginPath(); x.arc(8, 8, 7, 0, Math.PI * 2);
      x.fillStyle = '#ff3333'; x.fill();
      x.strokeStyle = '#cc0000'; x.lineWidth = 1; x.stroke();
      return c.toDataURL('image/png');
    })()`)
    _redDotImg = nativeImage.createFromDataURL(dataUrl)
  } catch (_) {}
  return _redDotImg
}

ipcMain.on('set-dm-badge', async (_evt, count) => {
  if (!mainWindow) return
  if (count > 0) {
    const img = await getRedDotImg()
    if (img) mainWindow.setOverlayIcon(img, `${count} unread DM${count === 1 ? '' : 's'}`)
  } else {
    mainWindow.setOverlayIcon(null, '')
    _redDotImg = null   // reset so it's re-drawn fresh next time
  }
})

app.whenReady().then(() => {
  buildMenu()
  createWindow()

  // Register as a global shortcut so it fires from the main process even
  // when the renderer's JS is consuming keyboard events (which blocks Alt).
  const _shortcutOk = globalShortcut.register('CmdOrCtrl+Shift+A', () => createAdminWindow())
  if (!_shortcutOk) {
    // Another app already owns this combo — fall back to menu item only (Alt → App → Admin Updater)
    console.warn('CmdOrCtrl+Shift+A global shortcut could not be registered (already claimed by another app).')
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('will-quit', () => { globalShortcut.unregisterAll() })

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
