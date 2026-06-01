import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  updateLanguage: (lang) => ipcRenderer.invoke('update-language', lang),
  getCurrentLanguage: () => ipcRenderer.invoke('get-current-language'),
  selectDirectory: (defaultPath = '') => ipcRenderer.invoke('select-directory', defaultPath),
  selectVideoFile: (defaultPath = '') => ipcRenderer.invoke('select-video-file', defaultPath),
  openOutputFolder: (subdir = '') => ipcRenderer.invoke('open-output-folder', subdir),
  getDesktopBridgeToken: () => ipcRenderer.invoke('get-desktop-bridge-token'),
  trackExtractorReady: () => ipcRenderer.invoke('track-extractor-ready'),
  onOpenTrackExtractor: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('open-track-extractor', listener);
    return () => ipcRenderer.removeListener('open-track-extractor', listener);
  },
  platform: process.platform,
  versions: process.versions
});

console.log('✅ Electron boot script installed');
