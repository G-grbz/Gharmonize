import { VideoSettingsManager } from './VideoSettingsManager.js';
import { JobManager } from './JobsPanelManager.js';
import { PreviewManager } from './PreviewManager.js';
import { SpotifyManager } from './SpotifyManager.js';
import { UploadManager } from './UploadManager.js';
import { FormatManager } from './FormatManager.js';
import { notificationManager } from './NotificationManager.js';
import { modalManager } from './ModalManager.js';

export class MediaConverterApp {
    constructor() {
        this._escapeMap = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;'
        };

        this.includeLyrics = false;
        this.currentSampleRate = 48000;
        this.videoManager = new VideoSettingsManager(this);
        this.jobManager = new JobManager(this);
        this.previewManager = new PreviewManager(this);
        this.spotifyManager = new SpotifyManager(this);
        this.uploadManager = new UploadManager(this);
        this.formatManager = new FormatManager(this);
        this.notificationManager = notificationManager;
        this.modalManager = modalManager;
    }

    async initialize() {
        this.initializeEventListeners();
        this.initializeTheme();
        await this.formatManager.loadFormats();
        this.videoManager.initialize();
        this.ensureWarnStyles();
        this.loadLocalFiles();
    }

    ensureWarnStyles() {
        if (document.getElementById('skipped-badge-style')) return;
        const st = document.createElement('style');
        st.id = 'skipped-badge-style';
        document.head.appendChild(st);
    }

    initializeTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const themeToggle = document.getElementById('themeToggle');
        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }

    initializeEventListeners() {
        document.getElementById('formatSelect').addEventListener('change', async (e) => {
            const format = e.target.value;
            this.formatManager.toggleFormatSpecificOptions(format);
            const formats = await this.formatManager.getFormats();
            this.formatManager.updateBitrateOptions(format, formats);
        });

        document.addEventListener('i18n:langChanged', () => {
            this.loadLocalFiles();
        });

        document.addEventListener('i18n:applied', () => {
            const localGroup = document.getElementById('localSourceGroup');
            if (localGroup && localGroup.style.display !== 'none') {
                this.loadLocalFiles();
            }
        });

        const fileForm = document.getElementById('fileForm');
        if (fileForm) {
            fileForm.addEventListener('submit', (e) => this.uploadManager.handleFileSubmit(e));
        }

        document.getElementById('previewBtn').addEventListener('click', () => this.previewManager.handlePreviewClick());
        document.getElementById('convertSelectedBtn').addEventListener('click', () => this.previewManager.convertSelected());
        document.getElementById('convertAllBtn').addEventListener('click', () => this.previewManager.convertAll());
        document.getElementById('selectAllChk').addEventListener('change', (e) => this.previewManager.toggleSelectAll(e.target.checked));
        document.getElementById('playlistCheckbox').addEventListener('change', (e) => this.onPlaylistToggle(e.target.checked));
        document.getElementById('prevPageBtn').addEventListener('click', () => this.previewManager.loadPage(this.previewManager.currentPreview.page - 1));
        document.getElementById('nextPageBtn').addEventListener('click', () => this.previewManager.loadPage(this.previewManager.currentPreview.page + 1));
        document.getElementById('pageSizeSel').addEventListener('change', (e) => {
            this.previewManager.currentPreview.pageSize = Number(e.target.value) || 50;
            if (this.previewManager.currentPreview.url) this.previewManager.loadPage(1, true);
        });
        document.getElementById('startIntegratedBtn').addEventListener('click', () => {
            this.spotifyManager.startIntegratedSpotifyProcess();
        });

        const urlForm = document.getElementById('urlForm');
        if (urlForm) {
            urlForm.addEventListener('submit', (e) => this.handleUrlSubmitWithSpinner(e));
        }

        const startSpotifyBtn = document.getElementById('startSpotifyBtn');
        const convertMatchedBtn = document.getElementById('convertMatchedBtn');

        if (startSpotifyBtn) {
            startSpotifyBtn.addEventListener('click', () => this.spotifyManager.startSpotifyPreview());
        }

        if (convertMatchedBtn) {
            convertMatchedBtn.addEventListener('click', () => this.spotifyManager.convertMatchedSpotify());
        }

        document.getElementById('urlInput').addEventListener('input', (e) => {
            this.onUrlInputChange(e.target.value);
        });

        document.querySelectorAll('.lang-toggle [data-lang]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await window.i18n?.setLang(btn.getAttribute('data-lang'));
            });
        });

        document.addEventListener('i18n:applied', () => {
            const modal = document.getElementById('settingsModal');
            if (modal) window.i18n?.apply?.(modal);
            if (this.previewManager.currentPreview.url) this.previewManager.renderPreview();
            for (const [id, job] of this.jobManager.jobStates.entries()) {
                this.jobManager.updateJobUI(job, this.jobManager.jobToBatch.get(id) || null);
            }
        });

        document.getElementById('lyricsCheckbox').addEventListener('change', (e) => {
            this.includeLyrics = e.target.checked;
        });

        document.getElementById('sampleRateSelect').addEventListener('change', (e) => {
            this.currentSampleRate = parseInt(e.target.value);
        });

        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this.uploadManager.resetUploadProgress();
            });
        }

        const sourceRadios = document.querySelectorAll('input[name="fileSourceType"]');
        if (sourceRadios.length) {
            sourceRadios.forEach(radio => {
                radio.addEventListener('change', () => {
                    const val = document.querySelector('input[name="fileSourceType"]:checked')?.value || 'upload';
                    const uploadGroup = document.getElementById('uploadSourceGroup');
                    const localGroup  = document.getElementById('localSourceGroup');

                    if (uploadGroup) {
                        uploadGroup.style.display = (val === 'upload') ? '' : 'none';
                    }
                    if (localGroup) {
                        localGroup.style.display = (val === 'local') ? '' : 'none';
                        if (val === 'local') {
                            this.loadLocalFiles();
                        }
                    }
                });
            });
        }

        const refreshLocalBtn = document.getElementById('refreshLocalFilesBtn');
        if (refreshLocalBtn) {
            refreshLocalBtn.addEventListener('click', () => this.loadLocalFiles());
        }
    }

    async loadLocalFiles() {
        const selectEl = document.getElementById('localFileSelect');
        const listEl   = document.getElementById('localFileCheckboxList');
        if (!selectEl && !listEl) return;

        const token = localStorage.getItem('gharmonize_admin_token') || '';
        if (!token) {
            if (selectEl) {
                selectEl.disabled = true;
                selectEl.innerHTML = `<option value="">${this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı'}</option>`;
            }
            if (listEl) {
                listEl.innerHTML = `<div class="local-files-empty">${this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı'}</div>`;
            }
            return;
        }

        try {
            if (selectEl) {
                selectEl.disabled = true;
                selectEl.innerHTML = `<option value="">${this.t('ui.loading')}...</option>`;
            }
            if (listEl) {
                listEl.innerHTML = `<div class="local-files-loading">${this.t('ui.loading') || 'Yükleniyor'}...</div>`;
            }

            const res = await fetch('/api/local-files', {
                headers: { 'Authorization': 'Bearer ' + token }
            });

            if (res.status === 401) {
                if (selectEl) {
                    selectEl.disabled = true;
                    selectEl.innerHTML = `<option value="">${this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı'}</option>`;
                }
                if (listEl) {
                    listEl.innerHTML = `<div class="local-files-empty">${this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı'}</div>`;
                }
                return;
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            const items = data.items || [];

            if (selectEl) {
                selectEl.disabled = false;
                selectEl.innerHTML = `<option value="">${this.t('ui.chooseServerFile') || '– Dosya seç –'}</option>`;
                items.forEach(f => {
                    const opt = document.createElement('option');
                    opt.value = f.name;
                    const sizeMb = (f.size / (1024 * 1024)).toFixed(1);
                    opt.textContent = `${f.name} (${sizeMb} MB)`;
                    selectEl.appendChild(opt);
                });
            }

            if (listEl) {
                if (!items.length) {
                    listEl.innerHTML = `<div class="local-files-empty">${this.t('ui.noServerFiles') || 'Sunucuda dosya bulunamadı'}</div>`;
                } else {
                    listEl.innerHTML = '';
                    items.forEach((f, idx) => {
                        const id = `local-file-${idx}`;
                        const sizeMb = (f.size / (1024 * 1024)).toFixed(1);

                        const wrapper = document.createElement('label');
                        wrapper.className = 'local-file-item';
                        wrapper.htmlFor = id;
                        wrapper.innerHTML = `
                            <input type="checkbox" id="${id}" name="localFileItem" value="${this.escapeHtml(f.name)}">
                            <span class="local-file-name">${this.escapeHtml(f.name)}</span>
                            <span class="local-file-size">(${sizeMb} MB)</span>
                        `;
                        listEl.appendChild(wrapper);
                    });

                    const info = document.createElement('div');
                    info.className = 'multi-select-info';
                    info.innerHTML = `💡 <strong>${this.t('ui.multiSelectHint') || 'Çoklu seçim:'}</strong> ${this.t('ui.multiSelectInstructions') || 'Birden fazla dosya seçebilirsiniz'}`;
                    listEl.appendChild(info);
                }
            }
        } catch (e) {
            console.error('Local files list error:', e);

            this.showNotification(
                `${this.t('notif.errorPrefix')}: ${e.message || 'local files'}`,
                'error',
                'error'
            );

            if (selectEl) {
                selectEl.disabled = true;
                selectEl.innerHTML = `<option value="">${this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı'}</option>`;
            }
            if (listEl) {
                listEl.innerHTML = `<div class="local-files-empty">${this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı'}</div>`;
            }
        }
    }

    addSelectionInfo() {
        const selectEl = document.getElementById('localFileSelect');
        const parent = selectEl.parentElement;
        const existingInfo = parent.querySelector('.multi-select-info');
        if (existingInfo) existingInfo.remove();

        const info = document.createElement('div');
        info.className = 'multi-select-info';
        info.style.fontSize = '12px';
        info.style.color = 'var(--text-muted)';
        info.style.marginTop = '8px';
        info.innerHTML = `💡 <strong>${this.t('ui.multiSelectHint') || 'Çoklu seçim için:'}</strong> ${this.t('ui.multiSelectInstructions') || 'Ctrl (Windows) veya Cmd (Mac) tuşuna basarak birden fazla dosya seçebilirsiniz.'}`;

        parent.appendChild(info);
    }

    onPlaylistToggle(isChecked) {
        if (isChecked) {
            const url = document.getElementById('urlInput').value.trim();
            if (!url) { this.previewManager.hidePreview(); return; }
            this.previewManager.previewPlaylist();
        } else {
            this.previewManager.hidePreview();
        }
    }

    onUrlInputChange(url) {
        const isSpotify = this.isSpotifyUrl(url);

        if (isSpotify) {
            document.getElementById('playlistCheckboxContainer').style.display = 'none';
            document.getElementById('normalUrlActions').style.display = 'none';
            document.getElementById('urlSpotifyActions').style.display = 'flex';
            document.getElementById('spotifyPreviewCard').style.display = 'block';
        } else {
            document.getElementById('playlistCheckboxContainer').style.display = 'flex';
            document.getElementById('normalUrlActions').style.display = 'flex';
            document.getElementById('urlSpotifyActions').style.display = 'none';
            document.getElementById('spotifyPreviewCard').style.display = 'none';
        }
    }

    isSpotifyUrl(u) {
        return /^(https?:\/\/open\.spotify\.com|spotify:)/i.test(String(u || ""));
    }

    async handleUrlSubmit(e) {
        e.preventDefault();
        const url = document.getElementById('urlInput').value.trim();
        const format = document.getElementById('formatSelect').value;
        const bitrate = document.getElementById('bitrateSelect').value;
        const sampleRateSelect = document.getElementById('sampleRateSelect');
        const sampleRate = sampleRateSelect ? parseInt(sampleRateSelect.value) : 48000;
        const isPlaylist = document.getElementById('playlistCheckbox').checked;
        const sequential = document.getElementById('sequentialChk')?.checked;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;

        if ((format === 'eac3' || format === 'ac3' || format === 'aac') && !sampleRate) {
            this.showNotification(this.t('notif.sampleRateRequired'), 'error', 'error');
            return;
        }

        if (this.isSpotifyUrl(url)) {
            if (!this.spotifyManager.currentSpotifyTask.completed) {
                this.showNotification(this.t('notif.completeSpotifyFirst'), 'error', 'error');
                return;
            }
            await this.spotifyManager.convertMatchedSpotify();
            return;
        }

        if (isPlaylist) {
            const selectedIndices = Array.from(this.previewManager.currentPreview.selected);
            if (sequential && selectedIndices.length > 1) {
                const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
                this.jobManager.ensureBatch(batchId, selectedIndices.length, { format, bitrate, source: this.t('ui.youtubePlaylist') });
                for (const idx of selectedIndices) {
                    const payload = {
                        url, format, bitrate,
                        sampleRate: sampleRate,
                        isPlaylist: true,
                        selectedIndices: [idx],
                        clientBatch: batchId,
                        includeLyrics
                    };
                    this.jobManager.submitJob(payload);
                }
            } else {
                const payload = {
                    url, format, bitrate,
                    isPlaylist: true,
                    sampleRate: sampleRate,
                    selectedIndices: selectedIndices.length ? selectedIndices : 'all',
                    includeLyrics
                };
                await this.jobManager.submitJob(payload);
            }
        } else {
            const payload = {
                url, format, bitrate,
                isPlaylist: false,
                sampleRate: Number(sampleRate),
                includeLyrics
            };
            await this.jobManager.submitJob(payload);
        }

        document.getElementById('urlForm').reset();
        document.getElementById('playlistCheckbox').checked = false;
        document.getElementById('lyricsCheckbox').checked = false;
        this.previewManager.hidePreview();
    }

    async handleUrlSubmitWithSpinner(e) {
        e.preventDefault();

        const startConvertBtn =
            document.getElementById('startConvertBtn') ||
            document.querySelector('#urlForm [type="submit"]');
        const spinner = startConvertBtn?.querySelector('.btn-spinner') || null;
        const btnText = startConvertBtn?.querySelector('.btn-text') || null;
        this.showButtonSpinner(startConvertBtn, spinner, btnText);

        try {
            const waitFirstUpdate = new Promise((resolve) => {
                const onFirst = () => resolve();
                const timeout = setTimeout(resolve, 15000);
                document.addEventListener('job:first-update', function handler() {
                    clearTimeout(timeout);
                    document.removeEventListener('job:first-update', handler);
                    onFirst();
                }, { once: true });
            });

            await this.handleUrlSubmit(e);
            await waitFirstUpdate;
        } catch (error) {
            console.error('URL gönderme hatası:', error);
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        } finally {
            this.hideButtonSpinner(startConvertBtn, startConvertBtn?.querySelector('.btn-spinner') || null, startConvertBtn?.querySelector('.btn-text') || null);
        }
    }

    showButtonSpinner(button, spinner, btnText) {
        if (!button) return;
        if (!spinner) {
            const sp = document.createElement('span');
            sp.className = 'btn-spinner';
            sp.style.display = 'inline-block';
            sp.style.marginRight = '6px';
            button.prepend(sp);
            spinner = sp;
        }
        if (!btnText) {
            const textNodes = [];
            button.childNodes.forEach(n => {
                if (n.nodeType === 3 && n.textContent.trim()) textNodes.push(n);
            });
            const txt = document.createElement('span');
            txt.className = 'btn-text';
            if (textNodes.length) {
                const raw = textNodes.map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
                if (raw) txt.textContent = raw;
            }
            textNodes.forEach(n => n.remove());
            button.appendChild(txt);
            btnText = txt;
        }
        button.classList.add('btn-loading');
        if (spinner) spinner.style.display = 'inline-block';
        button.disabled = true;
    }

    hideButtonSpinner(button, spinner, btnText) {
        if (!button) return;
        button.classList.remove('btn-loading');
        if (spinner) spinner.style.display = 'none';
        button.disabled = false;
    }

    escapeHtml(str) {
        if (str == null) return "";
        if (typeof str === "object") {
            const key = str.key || str.logKey || null;
            const vars = str.vars || str.logVars || null;
            const txt = str.text || str.fallback || "";
            if (key && typeof this.t === "function") {
                try { str = this.t(key, vars || {}) ?? txt ?? key; }
                catch { str = txt || key || ""; }
            } else {
                try { str = txt || JSON.stringify(str); } catch { str = String(str); }
            }
        }
        str = String(str);
        return str.replace(/[&<>"'`=\/]/g, s => this._escapeMap[s] || s);
    }

    formatSeconds(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return (h ? h.toString().padStart(2, '0') + ':' : '') + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
    }

    normalizeLog(msg) {
        if (msg == null) return '';
        if (typeof msg === 'string') {
            if (msg.startsWith('log.') || msg.startsWith('phase.') || msg.startsWith('status.')) {
                return this.t(msg);
            }
            return msg;
        }
        if (typeof msg === 'object') {
            if (msg.logKey) return this.t(msg.logKey, msg.logVars || {});
            if (msg.message) return this.normalizeLog(msg.message);
            if (msg.fallback) return msg.fallback;
            try { return JSON.stringify(msg); } catch { return String(msg); }
        }
        return String(msg);
    }

    normalizeBackendLog(txt) {
        if (txt == null) return '';
        try { txt = String(txt); } catch { return ''; }
        txt = txt.replace(/^SKIP_HINT:\s*/i, '');
        txt = txt.replace(/^SKIP_SUMMARY:\s*/i, '');
        if (txt.startsWith('log.') || txt.startsWith('phase.') || txt.startsWith('status.')) {
            try { return this.t(txt); } catch { }
        }
        return txt.replace(/\s+/g, ' ').trim();
    }

    toRelative(u) {
        if (!u) return u;
        try {
            const url = new URL(u, location.origin);
            if (url.origin === location.origin) {
                return url.pathname + url.search + url.hash;
            }
            return u;
        } catch {
            return u.replace(/^https?:\/\/[^/]+/i, '');
        }
    }

    t(key, vars) {
        if (typeof key === 'string' && key.startsWith('log.download.')) {
            const fixed = key.replace('log.download.', 'log.downloading.');
            const out = window.i18n?.t?.(fixed, vars);
            if (out && out !== fixed) return out;
        }
        return (window.i18n?.t?.(key, vars)) ?? key;
    }

    showNotification(message, type = 'info', group = 'default') {
        this.notificationManager.showNotification(message, type, group, 3000);
    }

    showQueueNotification(message) {
        this.showNotification(message, 'success', 'queue');
    }

    showErrorNotification(message) {
        this.showNotification(message, 'error', 'error');
    }

    showProgressNotification(message) {
        this.showNotification(message, 'info', 'progress');
    }
}
