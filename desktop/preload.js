// Preload — exposes window control methods to the renderer's main world.
// The titlebar DOM is injected by main.js via executeJavaScript after dom-ready.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__desktop__', {
  platform:    process.platform,
  version:     process.versions.electron,
  minimize:    () => ipcRenderer.send('win-minimize'),
  maximize:    () => ipcRenderer.send('win-maximize'),
  close:       () => ipcRenderer.send('win-close'),
  setDmBadge:  (n) => ipcRenderer.send('set-dm-badge', n),
})
