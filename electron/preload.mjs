import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  updateLanguage: (lang) => ipcRenderer.invoke('update-language', lang),
  getCurrentLanguage: () => ipcRenderer.invoke('get-current-language'),
  selectDirectory: (defaultPath = '') => ipcRenderer.invoke('select-directory', defaultPath),
  openOutputFolder: (subdir = '') => ipcRenderer.invoke('open-output-folder', subdir),
  platform: process.platform,
  versions: process.versions
});

console.log('✅ Electron boot script installed');
