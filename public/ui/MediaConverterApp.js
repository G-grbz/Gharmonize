import { VideoSettingsManager } from './VideoSettingsManager.js';
import { JobManager } from './JobManager.js';
import { PreviewManager } from './PreviewManager.js';
import { SpotifyManager } from './SpotifyManager.js';
import { UploadManager } from './UploadManager.js';
import { FormatManager } from './FormatManager.js';
import { notificationManager } from './NotificationManager.js';
import { modalManager } from './ModalManager.js';
import { settingsManager } from './SettingsManager.js';

export class MediaConverterApp {
    constructor() {
        this._escapeMap = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;', '/': '&#47;'
        };

        this.includeLyrics = false;
        this.currentSampleRate = 48000;
        this.currentVolumeGain = 1.0;
        this.videoManager = new VideoSettingsManager(this);
        this.jobManager = new JobManager(this);
        this.previewManager = new PreviewManager(this);
        this.spotifyManager = new SpotifyManager(this);
        this.uploadManager = new UploadManager(this);
        this.autoCreateZip = true;
        this.formatManager = new FormatManager(this);
        this.notificationManager = notificationManager;
        this.modalManager = modalManager;
        this.lastPreviewedPlaylistUrl = null;
        this.qualityLabelElement = null;
    }

    async initialize() {
        this.initializeTheme();
        const savedAutoZip = localStorage.getItem('autoCreateZip');
        if (savedAutoZip !== null) {
            this.autoCreateZip = savedAutoZip === 'true';
        }

        if (this.videoManager?.initialize) {
            await this.videoManager.initialize();
        }

        this.loadFfmpegCaps();
        this.initializeEventListeners();
        this.jobManager.restoreSessionState();

        await this.formatManager.loadFormats();
        this.ensureWarnStyles();
        this.loadLocalFiles();
        this.loadBinaryVersions().catch(err => {
            console.error('Failed to load binary versions:', err);
        });
    }

    parseSpotifyType(u) {
        if (!u) return null;
        const s = String(u).trim();
        const m1 = s.match(/^spotify:(track|album|playlist|artist|show|episode):/i);
        if (m1) return m1[1].toLowerCase();

        try {
            const url = new URL(s, window.location.origin);
            const host = url.hostname.toLowerCase();
            const isSpotifyHost =
            host.includes('spotify.com') ||
            host.includes('spotify.link') ||
            host.includes('spotify.app.link');

            if (!isSpotifyHost) return null;

            const parts = url.pathname.split('/').filter(Boolean);
            const t = (parts[0] || '').toLowerCase();
            if (['track','album','playlist','artist','show','episode'].includes(t)) return t;

            return null;
        } catch {
            return null;
        }
    }

    setAutoZipVisibility(show) {
        const c = document.getElementById('autoZipCheckboxContainer');
        if (!c) return;
        c.style.display = show ? 'flex' : 'none';
    }

    ensureWarnStyles() {
        if (document.getElementById('skipped-badge-style')) return;
        const st = document.createElement('style');
        st.id = 'skipped-badge-style';
        document.head.appendChild(st);
    }

    shouldShowAutoZipForCurrentUI({ url, total = null } = {}) {
        const format = document.getElementById('formatSelect')?.value || 'mp3';
        const isVideo = (format === 'mp4' || format === 'mkv');
        if (isVideo) return false;

        const u = (url ?? document.getElementById('urlInput')?.value ?? '').trim();
        if (!u) return false;

        if (this.isSpotifyUrl(u)) {
        if (total !== null && total !== undefined && total !== '') {
            const n = Number(total);
            if (Number.isFinite(n)) return n > 1;
        }

        if (/^https?:\/\/(spotify\.link|spotify\.app\.link)\//i.test(u)) return true;

        const t = this.parseSpotifyType(u);
        return (t === 'playlist' || t === 'album');
        }

        return this.isYoutubePlaylistUrl(u);
        }

    initializeTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        setTimeout(() => {
            document.documentElement.classList.remove('no-theme-transition');
        }, 100);

        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                document.documentElement.classList.add('no-transition');
                const currentTheme = document.documentElement.getAttribute('data-theme');
                const newTheme = currentTheme === 'light' ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                const meta = document.querySelector('meta[name="color-scheme"]');
                if (meta) {
                    meta.content = newTheme;
                }
                setTimeout(() => {
                    document.documentElement.classList.remove('no-transition');
                }, 2);

                themeToggle.classList.add('switching');
                setTimeout(() => {
                    themeToggle.classList.remove('switching');
                }, 50);
            });
        }
    }

    initializeEventListeners() {
        document.getElementById('formatSelect').addEventListener('change', async (e) => {
            const format = e.target.value;
            this.updateQualityLabel(format);
            this.formatManager.toggleFormatSpecificOptions(format);
            const formats = await this.formatManager.getFormats();
            this.formatManager.updateBitrateOptions(format, formats);
            this.setAutoZipVisibility(this.shouldShowAutoZipForCurrentUI());
        });

        document.addEventListener('i18n:langChanged', (ev) => {
            const newLang = ev?.detail?.lang || window.i18n?.getCurrentLang?.();
            const langSelect = document.getElementById('langSelect');
            if (langSelect && newLang && langSelect.value !== newLang) {
                langSelect.value = newLang;
            }
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

        const initialFormat = document.getElementById('formatSelect')?.value || 'mp3';
         this.updateQualityLabel(initialFormat);

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

        const startConvertBtn = document.getElementById('startConvertBtn');
        if (startConvertBtn) {
            startConvertBtn.addEventListener('click', (ev) => {
                const urlInput = document.getElementById('urlInput');
                const url = urlInput?.value.trim();
                const playlistCheckboxEl = document.getElementById('playlistCheckbox');

                if (
                    url &&
                    !this.isSpotifyUrl(url) &&
                    this.isYoutubePlaylistUrl(url) &&
                    playlistCheckboxEl &&
                    !playlistCheckboxEl.checked
                ) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    playlistCheckboxEl.checked = true;
                    this.onPlaylistToggle(true);
                    this.showNotification(
                        this.t('notif.autoPlaylistChecked') ||
                        'Bu URL bir YouTube playlist gibi görünüyor. Playlist modunu açtım, önce listeyi önizleyip sonra dönüştürebilirsin.',
                        'info',
                        'default'
                    );
                }
            });
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

        const langSelect = document.getElementById('langSelect');
        if (langSelect) {
            const currentLang = window.i18n?.getCurrentLang?.();
            if (currentLang && langSelect.value !== currentLang) {
                langSelect.value = currentLang;
            }

            langSelect.addEventListener('change', async (e) => {
                const nextLang = e.target.value;
                try {
                    await window.i18n?.setLang(nextLang);
                } catch (err) {
                    console.error('Failed to change language:', err);
                }
            });
        }

        const autoZipCheckbox = document.getElementById('autoZipCheckbox');
        if (autoZipCheckbox) {
            autoZipCheckbox.checked = this.autoCreateZip;
            autoZipCheckbox.addEventListener('change', (e) => {
                this.autoCreateZip = e.target.checked;
                localStorage.setItem('autoCreateZip', this.autoCreateZip.toString());
                this.showNotification(
                this.t('notif.autoZipSettingChanged', {
                    state: e.target.checked
                    ? this.t('ui.on') ?? 'On'
                    : this.t('ui.off') ?? 'Off'
                }),
                'info',
                'default'
                );
            });
        }

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

        const volumeRange = document.getElementById('volumeGainRange');
        const volumeLabel = document.getElementById('volumeGainValue');

        if (volumeRange && volumeLabel) {
            const settings = this.videoManager?.videoSettings || {};
            const initial = (typeof settings.volumeGain === 'number')
                ? settings.volumeGain
                : 1.0;

            volumeRange.value = initial.toFixed(1);
            volumeLabel.textContent = initial.toFixed(1) + 'x';
            this.currentVolumeGain = initial;

            const updateVolumeUI = () => {
                const v = parseFloat(volumeRange.value) || 1.0;
                this.currentVolumeGain = v;
                volumeLabel.textContent = v.toFixed(1) + 'x';

                if (this.videoManager && this.videoManager.videoSettings) {
                    this.videoManager.videoSettings.volumeGain = v;
                    this.videoManager.saveToStorage();
                }
            };
            volumeRange.addEventListener('input', updateVolumeUI);
        }

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

        const binaryFooter = document.getElementById('binaryFooter');
        const binaryFooterToggle = document.getElementById('binaryFooterToggle');

        if (binaryFooter && binaryFooterToggle) {
            binaryFooter.classList.add('collapsed');

            binaryFooterToggle.addEventListener('click', () => {
                binaryFooter.classList.toggle('collapsed');
            });
        }

    window.addEventListener('gharmonize:auth', (ev) => {
            const isLoggedIn = ev?.detail?.loggedIn ?? false;
            this.handleAuthStateChange(isLoggedIn);
        });
        this.checkInitialAuthState();
    }

    updateQualityLabel(format) {
         const qualityLabel = document.querySelector('label[for="bitrateSelect"]');
         if (!qualityLabel) return;

         const isVideo = (format === 'mp4' || format === 'mkv');
         const i18nKey = isVideo ? 'label.quality' : 'label.audioBitrate';
         qualityLabel.setAttribute('data-i18n', i18nKey);
         const videoText = this.t('label.quality') || 'Video Bitrate:';
         const audioText = this.t('label.audioBitrate') || 'Audio Bitrate:';
         qualityLabel.textContent = isVideo ? videoText : audioText;
     }

    handleAuthStateChange(isLoggedIn) {
        console.log('Auth state changed:', isLoggedIn);
        const jobsBell = document.getElementById('jobsBell');
        if (jobsBell) {
            jobsBell.hidden = !isLoggedIn;
        }
        if (!isLoggedIn && window.jobsPanelManager) {
            window.jobsPanelManager.close();
        }

        this.loadLocalFiles()?.catch?.(err => {
            console.error('loadLocalFiles after auth change failed:', err);
        });
    }

    async checkInitialAuthState() {
        const token = localStorage.getItem('gharmonize_admin_token');
        const isLoggedIn = !!token;

        if (token) {
            try {
                const response = await fetch('/api/auth/verify', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });

                if (!response.ok) {
                    throw new Error('Token invalid');
                }
            } catch (error) {
                localStorage.removeItem('gharmonize_admin_token');
                this.handleAuthStateChange(false);
                return;
            }
        }

        this.handleAuthStateChange(isLoggedIn);
    }

        async loadLocalFiles() {
            const selectEl = document.getElementById('localFileSelect');
            const listEl   = document.getElementById('localFileCheckboxList');
            if (!selectEl && !listEl) return;

            const token = localStorage.getItem('gharmonize_admin_token') || '';
            if (!token) {
                const msg = this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı';

                if (selectEl) {
                    selectEl.disabled = true;
                    selectEl.innerHTML = `<option value="">${msg}</option>`;
                }
                if (listEl) {
                    listEl.innerHTML = `<div class="local-files-empty">${msg}</div>`;
                    this.addLoginButtonToLocalFiles(listEl);
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
                    const msg = this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı';

                    if (selectEl) {
                        selectEl.disabled = true;
                        selectEl.innerHTML = `<option value="">${msg}</option>`;
                    }
                    if (listEl) {
                        listEl.innerHTML = `<div class="local-files-empty">${msg}</div>`;
                        this.addLoginButtonToLocalFiles(listEl);
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

                const msg = this.t('ui.noAuthLocalFiles') || 'Giriş yapılmadı';

                if (selectEl) {
                    selectEl.disabled = true;
                    selectEl.innerHTML = `<option value="">${msg}</option>`;
                }
                if (listEl) {
                    listEl.innerHTML = `<div class="local-files-empty">${msg}</div>`;
                    this.addLoginButtonToLocalFiles(listEl);
                }
            }
        }

        addLoginButtonToLocalFiles(listEl) {
        if (!listEl) return;
        if (listEl.querySelector('#localFilesLoginBtn')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'local-files-login-cta';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'localFilesLoginBtn';
        btn.className = 'btn-primary';
        btn.setAttribute('data-i18n', 'btn.login');
        btn.textContent = this.t('btn.login') || 'Login';

        wrapper.appendChild(btn);
        listEl.appendChild(wrapper);

        btn.addEventListener('click', () => {
            if (settingsManager?.openLoginOnly) {
                settingsManager.openLoginOnly();
            } else {
                settingsManager.open();
            }
        });
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
                this.setAutoZipVisibility(this.shouldShowAutoZipForCurrentUI());
                const url = document.getElementById('urlInput').value.trim();
                if (!url) { this.previewManager.hidePreview(); return; }
                this.previewManager.previewPlaylist();
            } else {
                this.setAutoZipVisibility(false);
                this.previewManager.hidePreview();
            }
        }

    onUrlInputChange(url) {
        const isSpotify = this.isSpotifyUrl(url);
        const isYoutubePl = !isSpotify && this.isYoutubePlaylistUrl(url);
        const spotifyConcContainer = document.getElementById('spotifyConcurrencyContainer');
        const youtubeConcContainer = document.getElementById('youtubeConcurrencyContainer');
        const playlistCheckboxEl = document.getElementById('playlistCheckbox');

        if (isSpotify) {
            document.getElementById('playlistCheckboxContainer').style.display = 'none';
            document.getElementById('normalUrlActions').style.display = 'none';
            document.getElementById('urlSpotifyActions').style.display = 'flex';
            document.getElementById('spotifyPreviewCard').style.display = 'block';
            if (spotifyConcContainer) spotifyConcContainer.style.display = 'flex';
            if (youtubeConcContainer) youtubeConcContainer.style.display = 'none';

            this.setAutoZipVisibility(this.shouldShowAutoZipForCurrentUI({ url }));
            this.lastPreviewedPlaylistUrl = null;
            return;
        }

        document.getElementById('playlistCheckboxContainer').style.display = 'flex';
        document.getElementById('normalUrlActions').style.display = 'flex';
        document.getElementById('urlSpotifyActions').style.display = 'none';
        document.getElementById('spotifyPreviewCard').style.display = 'none';
        if (spotifyConcContainer) spotifyConcContainer.style.display = 'none';
        if (youtubeConcContainer) youtubeConcContainer.style.display = 'flex';

        const trimmed = (url || '').trim();

        if (!isYoutubePl || !trimmed) {
            this.lastPreviewedPlaylistUrl = null;
            this.setAutoZipVisibility(false);
            return;
        }

        if (this.lastPreviewedPlaylistUrl === trimmed) {
            return;
        }
        this.lastPreviewedPlaylistUrl = trimmed;
        this.setAutoZipVisibility(true);

        if (playlistCheckboxEl) {
            playlistCheckboxEl.checked = true;
        }
        this.onPlaylistToggle(true);
    }

    isSpotifyUrl(u) {
        const s = String(u || "").trim();
        return /^(spotify:|https?:\/\/(open\.spotify\.com|spotify\.link|spotify\.app\.link))/i.test(s);
    }

    isYoutubePlaylistUrl(u) {
        if (!u) return false;
        const str = String(u);

        try {
            const url = new URL(str, window.location.origin);

            const host = url.hostname.toLowerCase();
            const isYoutubeHost =
                host.includes('youtube.com') ||
                host.includes('youtu.be') ||
                host.includes('music.youtube.com');

            if (isYoutubeHost) {
                if (url.searchParams.has('list')) return true;
                if (/\/playlist/i.test(url.pathname)) return true;
            }
        } catch {
    }

        if (/[?&]list=/.test(str)) return true;
        if (/\/playlist/i.test(str)) return true;

        return false;
    }

    async handleUrlSubmit(e) {
    e.preventDefault();
    const url = document.getElementById('urlInput').value.trim();
    const format = document.getElementById('formatSelect').value;
    const bitrate = document.getElementById('bitrateSelect').value;
    const sampleRateSelect = document.getElementById('sampleRateSelect');
    const sampleRate = sampleRateSelect ? parseInt(sampleRateSelect.value) : 48000;
    const playlistCheckboxEl = document.getElementById('playlistCheckbox');
    const isPlaylist = playlistCheckboxEl?.checked;
    const sequential = document.getElementById('sequentialChk')?.checked;
    const includeLyrics = document.getElementById('lyricsCheckbox').checked;
    const volumeGain = this.currentVolumeGain || 1.0;
    const youtubeConcurrency = document.getElementById('youtubeConcurrencyInput')?.value || '4';
    const autoCreateZip = this.autoCreateZip;

    let compressionLevel = null;
    let bitDepth = null;

    const bitDepthSelect = document.getElementById('bitDepthSelect');
    if (bitDepthSelect && (format === 'flac' || format === 'wav')) {
        bitDepth = bitDepthSelect.value || null;
    }

    const compRange = document.getElementById('compressionLevelRange');
    if (compRange && format === 'flac') {
        compressionLevel = parseInt(compRange.value, 10);
        if (!Number.isFinite(compressionLevel)) compressionLevel = null;
    }

    if ((format === 'eac3' || format === 'ac3' || format === 'aac' || format === 'dts') && !sampleRate) {
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

    if (isPlaylist && this.isYoutubePlaylistUrl(url)) {
        this.onPlaylistToggle(true);
        this.showNotification(
            this.t('notif.usePlaylistControls') ||
            'Bu URL bir playlist. Dönüştürmek için playlist önizleme kartındaki butonları kullan.',
            'info',
            'default'
        );
        return;
    }

        const payload = {
            url,
            format,
            bitrate,
            isPlaylist: false,
            sampleRate: Number(sampleRate),
            includeLyrics,
            volumeGain,
            autoCreateZip
        };
        await this.jobManager.submitJob(payload);

        document.getElementById('urlForm').reset();
        document.getElementById('playlistCheckbox').checked = false;
        document.getElementById('lyricsCheckbox').checked = false;
        this.previewManager.hidePreview();
        this.setAutoZipVisibility(false);
    }

    async loadBinaryVersions() {
        try {
            const res = await fetch('/api/binaries');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            const shortenVersion = (v) => {
                if (!v) return '';
                const nightly = v.match(/^N-(\d+)-(?:g[0-9a-f]+-)?(\d{8})$/);
                if (nightly) {
                    const date = nightly[2];
                    return date;
                }

                if (v.length > 20) {
                    return v.slice(0, 19) + '…';
                }

                return v;
            };
            const el = document.getElementById('binaryVersionsText');
            if (!el) return;

            const parts = [];

        if (data.ffmpeg?.version) {
            parts.push(`ffmpeg: ${shortenVersion(data.ffmpeg.version)}`);
            }
        if (data.ffprobe?.version) {
            parts.push(`ffprobe: ${shortenVersion(data.ffprobe.version)}`);
        }
        if (data.mkvmerge?.version) {
            parts.push(`mkvmerge: ${shortenVersion(data.mkvmerge.version)}`);
        }
        if (data.ytdlp?.version) {
            parts.push(`yt-dlp: ${shortenVersion(data.ytdlp.version)}`);
        }
        if (data.deno?.version) {
            parts.push(`deno: ${shortenVersion(data.deno.version)}`);
        }

            el.textContent = parts.join(' • ');
        } catch (e) {
            console.error('loadBinaryVersions error:', e);
            const el = document.getElementById('binaryVersionsText');
            if (el) {
                el.textContent = this.t('ui.binaryVersionsError') || 'Binary versiyonları okunamadı';
            }
        }
    }

    async loadFfmpegCaps() {
    try {
        const res = await fetch('/api/ffmpeg/caps', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (data?.ok && data?.caps) {
            console.log('[ffmpegCaps] loaded:', data.caps);
            this.videoManager?.setFfmpegCaps(data.caps);
        } else {
            console.warn('[ffmpegCaps] api returned not-ok:', data);
            this.videoManager?.setFfmpegCaps(null);
        }
    } catch (err) {
        console.warn('[ffmpegCaps] load failed:', err);
        this.videoManager?.setFfmpegCaps(null);
    }
}

    async handleUrlSubmitWithSpinner(e) {
        e.preventDefault();

        const urlInput = document.getElementById('urlInput');
        const url = urlInput?.value.trim();
        const playlistCheckboxEl = document.getElementById('playlistCheckbox');

        if (
            url &&
            !this.isSpotifyUrl(url) &&
            this.isYoutubePlaylistUrl(url)
        ) {
            if (playlistCheckboxEl) {
                playlistCheckboxEl.checked = true;
            }
            this.onPlaylistToggle(true);

            this.showNotification(
                this.t('notif.autoPlaylistChecked') ||
                'Bu URL bir YouTube playlist gibi görünüyor. Lütfen dönüşümleri önizleme penceresinden başlatın.',
                'info',
                'default'
            );
            return;
        }

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
            console.error('URL submission error:', error);
            this.showNotification(`${this.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        } finally {
            this.hideButtonSpinner(
                startConvertBtn,
                startConvertBtn?.querySelector('.btn-spinner') || null,
                startConvertBtn?.querySelector('.btn-text') || null
            );
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
