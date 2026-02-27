export class PreviewManager {
    // Initializes class state and defaults for the browser UI layer.
    constructor(app) {
        this.app = app;
        this.currentPreview = {
            url: null, items: [], selected: new Set(),
            title: '', count: 0, page: 1, pageSize: 25,
            isSpotify: false, streaming: false,
            indexToId: new Map(),
            indexToTitle: new Map(),
            indexToUploader: new Map(),
            indexToDuration: new Map(),
            indexToWebpageUrl: new Map()
        };
        this.previewAbort = null;
    }

    // Cleans up uploader for the browser UI layer.
    cleanUploader(uploader = '') {
        let s = String(uploader).trim().replace(/\s+/g, ' ');

        s = s.replace(/\s*-\s*(topic)\s*$/i, '');
        s = s.replace(/\s*-\s*(official)(?:\s+(channel))?\s*$/i, '');
        s = s.replace(/\s+(official|topic)\s*$/i, '');
        s = s.replace(/\s*\((official)\)\s*$/i, '');
        s = s.replace(/\s+(?:and|&)\s+/gi, ', ');
        s = s.replace(/\s*,\s*/g, ', ');

        return s.trim();
    }

    // Detects playlist platform from URL for the browser UI layer.
    detectPlaylistPlatform(url = '') {
        const s = String(url || '').trim();
        if (/(?:dailymotion\.com|dai\.ly)/i.test(s)) return 'dailymotion';
        return 'youtube';
    }

    // Normalizes artist tokens for the browser UI layer.
    normalizeArtistTokens(value = '') {
        return String(value || '')
            .toLowerCase()
            .replace(/[&+]/g, ' and ')
            .replace(/[,/]/g, ' ')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .map(t => t.trim())
            .filter(Boolean)
            .filter(t => t !== 'and');
    }

    // Handles looks like artist in the browser UI layer.
    looksLikeArtist(candidate = '', uploader = '') {
        const a = this.normalizeArtistTokens(candidate);
        const b = this.normalizeArtistTokens(uploader);
        if (!a.length || !b.length) return false;

        const aSet = new Set(a);
        const bSet = new Set(b);
        let overlap = 0;
        aSet.forEach(t => { if (bSet.has(t)) overlap += 1; });
        return overlap >= Math.max(1, Math.ceil(Math.min(aSet.size, bSet.size) * 0.6));
    }

    // Parses title artist pair for the browser UI layer.
    parseTitleArtistPair(title = '', uploader = '') {
        const raw = String(title || '').trim();
        if (!raw) return null;
        const extractPrimary = (value = '') =>
            String(value || '')
                .split(/\s*(?:[-–—|｜·•])\s*|\s+\bl\b\s+/gi)
                .map(p => p.trim())
                .filter(Boolean)[0] || '';

        const lParts = raw
            .split(/\s+\bl\b\s+/i)
            .map(p => p.trim())
            .filter(Boolean);

        if (lParts.length >= 2) {
            const left = (lParts[0] || '').trim();
            const right = this.cleanUploader((lParts[1] || '').trim());
            if (!left || !right) return null;
            return { artist: left, track: right };
        }

        const m = raw.match(/^(.+?)\s*[-–—]\s+(.+)$/);
        if (!m) return null;

        const left = (m[1] || '').trim();
        const right = (m[2] || '').trim();
        if (!left || !right) return null;
        const rightHasExtraParts = /(?:\s+[-–—|｜·•]\s+|\s+\bl\b\s+)/i.test(right);
        if (rightHasExtraParts) {
            const rightPrimary = extractPrimary(right);
            return { artist: left, track: rightPrimary || right };
        }

        const cleanedUploader = this.cleanUploader(uploader || '');
        if (cleanedUploader) {
            const leftLooksArtist = this.looksLikeArtist(left, cleanedUploader);
            const rightLooksArtist = this.looksLikeArtist(right, cleanedUploader);
            if (leftLooksArtist && !rightLooksArtist) {
                return { artist: left, track: right };
            }
            if (rightLooksArtist && !leftLooksArtist) {
                return { artist: right, track: left };
            }
        }

        return { artist: left, track: right };
    }

    // Returns artist display used for the browser UI layer.
    getArtistDisplay(item) {
        const title = (item?.title || '').toString().trim();
        const pair = this.parseTitleArtistPair(title, item?.uploader || '');
        if (pair?.artist && !pair.artist.startsWith('-')) {
            return this.cleanUploader(pair.artist);
        }

        return this.cleanUploader(item?.uploader || '');
    }

    // Selects track title for the browser UI layer.
    pickTrackTitle(item) {
        const rawTitle = (item?.title || '').toString().trim();
        if (!rawTitle) return '';

        const uploader = this.cleanUploader(item?.uploader || '');
        const pair = this.parseTitleArtistPair(rawTitle, uploader);
        if (pair?.track) return pair.track;

        const parts = rawTitle
            .split(/\s*(?:[-–—|｜·•])\s*|\s+\bl\b\s+/gi)
            .map(p => p.trim())
            .filter(Boolean);

        if (parts.length >= 3) {
            return parts.slice(0, -1).join(' - ');
        }

        if (parts.length < 2) return rawTitle;

        const uploaderIdx = parts.findIndex(p => this.looksLikeArtist(p, uploader));
        if (uploaderIdx >= 0) {
            const candidates = parts.filter((_, i) => i !== uploaderIdx);
            if (!candidates.length) return rawTitle;
            return candidates.sort((a, b) => b.length - a.length)[0];
        }

        if (this.looksLikeArtist(parts[0], uploader)) return parts[parts.length - 1];
        if (this.looksLikeArtist(parts[parts.length - 1], uploader)) return parts[0];

        return parts[0];
    }

    // Handles clean title for UI state in the browser UI layer.
    cleanTitleForUI(title = '') {
        let s = String(title || '').trim();
        s = s.replace(/\s*_\s*/g, ' • ');
        s = s.replace(/\s*\|\s*/g, ' • ');
        s = s.replace(/\s*•\s*•+\s*/g, ' • ');
        s = s.replace(/\s{2,}/g, ' ').trim();
        s = s.replace(/\s*(?:•\s*)+$/, '').trim();

        const junk = [
            'official', 'official video', 'official audio', 'audio', 'video',
            'lyrics', 'lyric', 'lyrics video', 'şarkı sözü', 'şarki sözü', 'sarki sozu',
            'hd', '4k', 'remastered', 'remaster', 'edit', 'extended'
        ];

        s = s.replace(/\[([^\]]+)\]/g, (m, inner) => {
            const t = inner.toString().trim().toLowerCase();
            if (junk.some(j => t === j || t.includes(j))) return '';
            return m;
        });

        s = s.replace(/\(([^)]+)\)/g, (m, inner) => {
            const t = inner.toString().trim().toLowerCase();
            if (junk.some(j => t === j || t.includes(j))) return '';
            return m;
        });

        s = s.replace(/\s{2,}/g, ' ').trim();
        s = s.replace(/\s*(?:•\s*)+$/, '').trim();
        return s;
    }

    // Handles handle preview click in the browser UI layer.
    async handlePreviewClick() {
        const url = document.getElementById('urlInput').value.trim();
        if (this.app.isSpotifyUrl(url)) {
            this.app.spotifyManager.startSpotifyPreview();
        } else {
            this.previewPlaylist();
        }
    }

    // Handles preview playlist data in the browser UI layer.
    async previewPlaylist() {
        const url = document.getElementById('urlInput').value.trim();
        const isPlaylist = document.getElementById('playlistCheckbox').checked;
        const btn = document.getElementById('previewBtn');
        const startConvertBtn = document.getElementById('startConvertBtn');

        if (!url) {
            this.app.showNotification(this.app.t('notif.needUrl'), 'error', 'error');
            return;
        }

        this.currentPreview.isSpotify = false;
        this.currentPreview.streaming = false;
        this.currentPreview.selected = new Set();
        this.currentPreview.items = [];
        this.currentPreview.indexToId.clear();
        this.currentPreview.indexToTitle.clear();
        this.currentPreview.indexToUploader.clear();
        this.currentPreview.indexToDuration.clear();
        this.currentPreview.indexToWebpageUrl.clear();

        if (this.app.isSpotifyUrl(url)) {
            try {
                btn?.classList.add('btn-loading');
                btn?.setAttribute('disabled', 'disabled');
                btn.textContent = this.app.t('ui.loading');

                startConvertBtn?.setAttribute('disabled', 'disabled');

                const batchSize = Number(document.getElementById('pageSizeSel').value) || 10;
                await this.streamPreviewByPaging(url, Math.max(1, Math.min(50, batchSize)));
            } catch (e) {
                this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
            } finally {
                btn?.classList.remove('btn-loading');
                btn?.removeAttribute('disabled');
                btn.textContent = this.app.t('btn.preview');

                startConvertBtn?.removeAttribute('disabled');
            }
            return;
        }

        if (!isPlaylist) {
            this.app.showNotification(this.app.t('notif.checkPlaylist'), 'error', 'error');
            return;
        }

        this.currentPreview.url = url;
        this.currentPreview.page = 1;
        this.currentPreview.pageSize = Number(document.getElementById('pageSizeSel').value) || 25;

        try {
            btn?.classList.add('btn-loading');
            btn?.setAttribute('disabled', 'disabled');
            btn.textContent = this.app.t('ui.loading');

            startConvertBtn?.setAttribute('disabled', 'disabled');

            if (this.previewAbort) this.previewAbort.abort();
            this.previewAbort = new AbortController();
            const res = await fetch('/api/playlist/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    page: this.currentPreview.page,
                    pageSize: this.currentPreview.pageSize
                }),
                signal: this.previewAbort.signal
            });
            const data = await res.json();
            if (!res.ok) {
                const code = data?.error?.code || 'PREVIEW_FAILED';
                throw new Error(this.app.t(`errors.${code}`) || this.app.t('errors.previewFailed'));
            }

            this.currentPreview.items = data.items || [];
            this.currentPreview.title = data.playlist?.title || '';
            this.currentPreview.count = data.playlist?.count || 0;
            document.getElementById('pageNo').textContent = String(this.currentPreview.page);
            document.getElementById('pageSizeSel').value = String(this.currentPreview.pageSize);
            this.renderPreview();
            this.showPreview();
        } catch (e) {
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
        } finally {
            btn?.classList.remove('btn-loading');
            btn?.removeAttribute('disabled');
            btn.textContent = this.app.t('btn.preview');

            startConvertBtn?.removeAttribute('disabled');
        }
    }

    // Streams preview by paging in the browser UI layer.
    async streamPreviewByPaging(url, batchSize) {
        this.currentPreview.url = url;
        this.currentPreview.isSpotify = true;
        this.currentPreview.streaming = true;
        this.currentPreview.selected = new Set();
        this.currentPreview.items = [];
        this.currentPreview.indexToId.clear();
        this.currentPreview.indexToTitle.clear();
        this.currentPreview.indexToUploader.clear();
        this.currentPreview.indexToDuration.clear();
        this.currentPreview.indexToWebpageUrl.clear();
        this.currentPreview.page = 1;
        this.currentPreview.pageSize = batchSize;
        this.showPreview();

        const listEl = document.getElementById('previewList');
        const pagerPrev = document.getElementById('prevPageBtn');
        const pagerNext = document.getElementById('nextPageBtn');
        pagerPrev.disabled = true;
        pagerNext.disabled = true;

        const first = await fetch('/api/playlist/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, page: 1, pageSize: batchSize })
        });
        const firstData = await first.json();
        if (!first.ok) throw new Error(firstData?.error?.message || this.app.t('errors.previewFailed'));
        this.currentPreview.title = firstData?.playlist?.title || '-';
        this.currentPreview.count = Number(firstData?.playlist?.count || 0);
        document.getElementById('plTitle').textContent = this.currentPreview.title;
        document.getElementById('plCount').textContent = this.currentPreview.count;
        document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
        listEl.innerHTML = '';

        this.appendPreviewItems(firstData.items || []);
        this.updateStreamLog(firstData.items?.at(-1));
        const totalPages = Math.max(1, Math.ceil(this.currentPreview.count / batchSize));
        for (let p = 2; p <= totalPages; p++) {
            if (this.previewAbort) this.previewAbort.abort();
            this.previewAbort = new AbortController();
            const res = await fetch('/api/playlist/preview', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, page: p, pageSize: batchSize }),
                signal: this.previewAbort.signal
            });
            const data = await res.json();
            if (!res.ok) break;
            this.appendPreviewItems(data.items || []);
            this.updateStreamLog(data.items?.at(-1));
        }
        this.currentPreview.streaming = false;
        this.updateStreamLog(null, true);
    }

    // Handles append preview items in the browser UI layer.
    appendPreviewItems(items) {
        const listEl = document.getElementById('previewList');
        for (const item of items) {
            this.currentPreview.items.push(item);
            if (item && Number.isFinite(item.index)) {
                this.currentPreview.indexToId.set(item.index, item.id || null);
                this.currentPreview.indexToTitle.set(item.index, this.pickTrackTitle(item) || '');
                this.currentPreview.indexToUploader.set(item.index, this.getArtistDisplay(item) || '');
                this.currentPreview.indexToDuration.set(
                    item.index,
                    Number.isFinite(item.duration) ? item.duration : null
                );
                this.currentPreview.indexToWebpageUrl.set(item.index, item.webpage_url || '');
            }

            const artistName = this.getArtistDisplay(item);
            const titleForRow = this.cleanTitleForUI(item.title || item.id || item.webpage_url || '');

            const row = document.createElement('div');
            row.className = 'preview-row';
            row.innerHTML = `
                <img class="preview-thumb" src="${item.thumbnail || ''}" alt="thumb" onerror="this.style.display='none'" />
                <div>
                    <div class="preview-title">${item.index}. ${this.app.escapeHtml(titleForRow)}</div>
                    <div class="muted">${this.app.escapeHtml(artistName)}</div>
                </div>
                <div class="row-right muted">${item.duration_string || (item.duration ? this.app.formatSeconds(item.duration) : '-')}</div>
                <div class="row-right"><input type="checkbox" data-index="${item.index}" /></div>
            `;
            listEl.appendChild(row);
            const chk = row.querySelector('input[type="checkbox"]');
            chk.checked = this.currentPreview.selected.has(item.index);
            chk.addEventListener('change', (e) => {
                const i = Number(e.target.getAttribute('data-index'));
                if (e.target.checked) this.currentPreview.selected.add(i);
                else this.currentPreview.selected.delete(i);
                document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
                this.updateSelectAllState();
            });
        }
    }

    // Updates stream payload log for the browser UI layer.
    updateStreamLog(lastItem, done = false) {
        const el = document.getElementById('plStreamLog');
        if (!el) return;
        el.style.display = 'block';
        const total = this.currentPreview.items.length;
        if (done) {
            el.textContent = this.app.t('ui.streamDone') + ` • ${this.app.t('ui.totalTracksLoaded', { count: total })}`;
            setTimeout(() => { el.style.display = 'none'; }, 2500);
            return;
        }
        if (lastItem) {
            const name = (lastItem?.title || '').toString();
            el.textContent = this.app.t('ui.streamAdded') + `: ${name} • ${total} / ${this.currentPreview.count}`;
        } else {
            el.textContent = `${this.app.t('ui.loading')}… ${total} / ${this.currentPreview.count}`;
        }
    }

    // Loads page for the browser UI layer.
    async loadPage(p, force = false) {
        if (!this.currentPreview.url) return;
        if (this.currentPreview.isSpotify && this.currentPreview.streaming) {
            this.app.showNotification(this.app.t('ui.liveModeNoPaging'), 'info');
            return;
        }
        const total = this.currentPreview.count || 0;
        const maxPage = Math.max(1, Math.ceil(total / this.currentPreview.pageSize));
        const next = Math.min(Math.max(1, p), maxPage);
        if (next === this.currentPreview.page && !force) return;
        try {
            const prevBtn = document.getElementById('prevPageBtn');
            const nextBtn = document.getElementById('nextPageBtn');
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            const listEl = document.getElementById('previewList');
            listEl.innerHTML = `<div class="muted" style="padding:16px">${this.app.t('ui.loading')}</div>`;
            if (this.previewAbort) this.previewAbort.abort();
            this.previewAbort = new AbortController();
            const res = await fetch('/api/playlist/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: this.currentPreview.url,
                    page: next,
                    pageSize: this.currentPreview.pageSize
                }),
                signal: this.previewAbort.signal
            });
            const data = await res.json();
            if (!res.ok) {
                const code = data?.error?.code || 'PAGE_FETCH_FAILED';
                throw new Error(this.app.t(`errors.${code}`) || this.app.t('errors.pageLoadFailed'));
            }
            this.currentPreview.page = data.page || next;
            this.currentPreview.items = data.items || [];
            this.currentPreview.title = data.playlist?.title || this.currentPreview.title;
            this.currentPreview.count = data.playlist?.count ?? this.currentPreview.count;
            document.getElementById('pageNo').textContent = String(this.currentPreview.page);
            this.renderPreview();
        } catch (e) {
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
        } finally {
            const prevBtn = document.getElementById('prevPageBtn');
            const nextBtn = document.getElementById('nextPageBtn');
            prevBtn.disabled = false;
            nextBtn.disabled = false;
        }
    }

    // Renders preview in the browser UI layer.
    renderPreview() {
        const listEl = document.getElementById('previewList');
        const titleEl = document.getElementById('plTitle');
        const countEl = document.getElementById('plCount');
        const selectedEl = document.getElementById('plSelected');
        const selectAllEl = document.getElementById('selectAllChk');

        if (this.currentPreview.isSpotify && this.currentPreview.streaming) {
            titleEl.textContent = this.currentPreview.title || '-';
            countEl.textContent = this.currentPreview.count;
            selectedEl.textContent = this.currentPreview.selected.size;
            return;
        }

        listEl.innerHTML = '';
        titleEl.textContent = this.currentPreview.title || '-';
        countEl.textContent = this.currentPreview.count;
        selectedEl.textContent = this.currentPreview.selected.size;

        this.currentPreview.items.forEach((item) => {
            if (item && Number.isFinite(item.index)) {
                this.currentPreview.indexToId.set(item.index, item.id || null);
                this.currentPreview.indexToTitle.set(item.index, this.pickTrackTitle(item) || '');
                this.currentPreview.indexToUploader.set(item.index, this.getArtistDisplay(item) || '');
                this.currentPreview.indexToDuration.set(
                    item.index,
                    Number.isFinite(item.duration) ? item.duration : null
                );
                this.currentPreview.indexToWebpageUrl.set(item.index, item.webpage_url || '');
            }

            const artistName = this.getArtistDisplay(item);
            const titleForRow = this.cleanTitleForUI(item.title || item.id || item.webpage_url || '');

            const row = document.createElement('div');
            row.className = 'preview-row';
            row.innerHTML = `
                <img class="preview-thumb" src="${item.thumbnail || ''}" alt="thumb" onerror="this.style.display='none'" />
                <div>
                    <div class="preview-title">${item.index}. ${this.app.escapeHtml(titleForRow)}</div>
                    <div class="muted">${this.app.escapeHtml(artistName)}</div>
                </div>
                <div class="row-right muted">${item.duration_string || (item.duration ? this.app.formatSeconds(item.duration) : '-')}</div>
                <div class="row-right"><input type="checkbox" data-index="${item.index}" /></div>
            `;
            listEl.appendChild(row);
        });

        listEl.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
            const idx = Number(chk.getAttribute('data-index'));
            chk.checked = this.currentPreview.selected.has(idx);
            chk.addEventListener('change', (e) => {
                const i = Number(e.target.getAttribute('data-index'));
                if (e.target.checked) this.currentPreview.selected.add(i);
                else this.currentPreview.selected.delete(i);
                document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
                this.updateSelectAllState();
            });
        });

        this.updateSelectAllState();
    }

    // Updates select all state for the browser UI layer.
    updateSelectAllState() {
        const listEl = document.getElementById('previewList');
        const chks = [...listEl.querySelectorAll('input[type="checkbox"]')];
        const totalVisible = chks.length;
        const selectedVisible = chks.filter(c => c.checked).length;
        const allEl = document.getElementById('selectAllChk');

        if (totalVisible === 0) {
            allEl.checked = false;
            allEl.indeterminate = false;
            return;
        }
        if (selectedVisible === 0) {
            allEl.checked = false;
            allEl.indeterminate = false;
        } else if (selectedVisible === totalVisible) {
            allEl.checked = true;
            allEl.indeterminate = false;
        } else {
            allEl.checked = false;
            allEl.indeterminate = true;
        }

        document.getElementById('plSelected').textContent = this.currentPreview.selected.size;
    }

    // Handles toggle select all in the browser UI layer.
    toggleSelectAll(flag) {
        const listEl = document.getElementById('previewList');
        const chks = listEl.querySelectorAll('input[type="checkbox"]');
        chks.forEach((chk) => {
            const idx = Number(chk.getAttribute('data-index'));
            chk.checked = !!flag;
            if (flag) this.currentPreview.selected.add(idx);
            else this.currentPreview.selected.delete(idx);
        });
        this.updateSelectAllState();
    }

    // Converts selected for the browser UI layer.
    async convertSelected() {
        if (!this.currentPreview.url) {
            this.app.showNotification(this.app.t('notif.previewFirst'), 'error', 'error');
            return;
        }

        const selected = Array.from(this.currentPreview.selected).sort((a, b) => a - b);
        if (!selected.length) {
            this.app.showNotification(this.app.t('notif.selectAtLeastOne'), 'error', 'error');
            return;
        }

        const convertBtn = document.getElementById('convertSelectedBtn');
        const originalText = convertBtn.textContent;

        try {
            convertBtn.classList.add('btn-loading');
            convertBtn.disabled = true;
            convertBtn.textContent = this.app.t('ui.processing') || 'İşleniyor...';

            const format = document.getElementById('formatSelect').value;
            const bitrate = document.getElementById('bitrateSelect').value;
            const sampleRate = document.getElementById('sampleRateSelect').value;
            const sequential = document.getElementById('sequentialChk')?.checked;
            const includeLyrics = document.getElementById('lyricsCheckbox').checked;
            const embedLyrics = !!document.getElementById('embedLyricsCheckbox')?.checked;
            const volumeGain = this.app.currentVolumeGain || 1.0;
            const compressionLevel =
            format === 'flac'
                ? (document.getElementById('compressionLevelRange')?.value || '5')
                : undefined;

            const ytConcEl = document.getElementById('youtubeConcurrencyInput');
            const youtubeConcurrency = ytConcEl ? Number(ytConcEl.value) || 4 : 4;

            const selectedIdRaw = selected.map(i => this.currentPreview.indexToId.get(i) || null);
            const selectedIdsComplete = selectedIdRaw.every(Boolean);
            const selectedIds = selectedIdsComplete ? selectedIdRaw : null;
            const plTitle = String(this.currentPreview.title || '').trim();

            const frozenEntries = selected.map(idx => ({
                index: idx,
                id: this.currentPreview.indexToId.get(idx) || null,
                title: this.currentPreview.indexToTitle.get(idx) || '',
                uploader: this.currentPreview.indexToUploader.get(idx) || '',
                duration: this.currentPreview.indexToDuration.has(idx)
                    ? this.currentPreview.indexToDuration.get(idx)
                    : null,
                webpage_url: this.currentPreview.indexToWebpageUrl.get(idx) || ''
            }));

            if (sequential && selected.length > 1) {
                const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
                this.app.jobManager.ensureBatch(batchId, selected.length, {
                    format,
                    bitrate,
                    source: this.detectPlaylistPlatform(this.currentPreview.url)
                });
                for (const idx of selected) {
                    const idFromMap = this.currentPreview.indexToId.get(idx);
                    const itemId = idFromMap ? [idFromMap] : null;

                    const frozenForIdx = frozenEntries.filter(e => e.index === idx);

                    await this.app.jobManager.submitJob({
                        url: this.currentPreview.url,
                        isPlaylist: true,
                        plTitle,
                        selectedIndices: [idx],
                        selectedIds: itemId,
                        format,
                        bitrate,
                        sampleRate,
                        clientBatch: batchId,
                        includeLyrics,
                        embedLyrics,
                        autoCreateZip: this.app.autoCreateZip,
                        volumeGain,
                        youtubeConcurrency,
                        frozenEntries: frozenForIdx
                    });
                }
            } else {
                await this.app.jobManager.submitJob({
                    url: this.currentPreview.url,
                    isPlaylist: true,
                    plTitle,
                    selectedIndices: selected,
                    selectedIds,
                    format,
                    bitrate,
                    sampleRate,
                    includeLyrics,
                    embedLyrics,
                    autoCreateZip: this.app.autoCreateZip,
                    volumeGain,
                    youtubeConcurrency,
                    frozenEntries
                });
            }

            this.app.showNotification(this.app.t('notif.tracksQueued', { count: selected.length }), 'success', 'queue');

        } catch (error) {
            console.error('Error converting selected items:', error);
            this.app.showNotification(`${this.app.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        } finally {
            convertBtn.classList.remove('btn-loading');
            convertBtn.disabled = false;
            convertBtn.textContent = originalText;
        }
    }

    // Converts all for the browser UI layer.
    async convertAll() {
        if (!this.currentPreview.url) {
            this.app.showNotification(this.app.t('notif.previewFirst'), 'error', 'error');
            return;
        }

        const convertAllBtn = document.getElementById('convertAllBtn');
        const originalText = convertAllBtn.textContent;

        try {
            convertAllBtn.classList.add('btn-loading');
            convertAllBtn.disabled = true;
            convertAllBtn.textContent = this.app.t('ui.processing') || 'İşleniyor...';

            const format = document.getElementById('formatSelect').value;
            const bitrate = document.getElementById('bitrateSelect').value;
            const sampleRate = document.getElementById('sampleRateSelect').value;
            const includeLyrics = document.getElementById('lyricsCheckbox').checked;
            const embedLyrics = !!document.getElementById('embedLyricsCheckbox')?.checked;
            const volumeGain = this.app.currentVolumeGain || 1.0;
            const ytConcEl = document.getElementById('youtubeConcurrencyInput');
            const youtubeConcurrency = ytConcEl ? Number(ytConcEl.value) || 4 : 4;
            const allIdsRaw = this.currentPreview.items.map(item => item.id || null);
            const allIdsComplete = allIdsRaw.length > 0 && allIdsRaw.every(Boolean);
            const allIds = allIdsComplete ? allIdsRaw : null;
            const plTitle = String(this.currentPreview.title || '').trim();

            const frozenEntries = this.currentPreview.items.map(item => ({
                index: item.index,
                id: item.id || null,
                title: this.pickTrackTitle(item),
                uploader: this.cleanUploader(item.uploader || ''),
                duration: item.duration || null,
                webpage_url: item.webpage_url || ''
            }));

            await this.app.jobManager.submitJob({
                url: this.currentPreview.url,
                isPlaylist: true,
                plTitle,
                selectedIndices: 'all',
                selectedIds: allIds,
                format,
                bitrate,
                sampleRate,
                includeLyrics,
                embedLyrics,
                autoCreateZip: this.app.autoCreateZip,
                volumeGain,
                youtubeConcurrency,
                frozenEntries
            });

            this.app.showNotification(this.app.t('notif.allTracksQueued'), 'success', 'queue');

        } catch (error) {
            console.error('Error converting all items:', error);
            this.app.showNotification(`${this.app.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        } finally {
            convertAllBtn.classList.remove('btn-loading');
            convertAllBtn.disabled = false;
            convertAllBtn.textContent = originalText;
        }
    }

    // Shows preview in the browser UI layer.
    showPreview() {
        document.getElementById('spotifyPreviewCard').style.display = 'none';
        document.getElementById('playlistPreviewCard').style.display = 'block';
    }

    // Hides preview in the browser UI layer.
    hidePreview() {
        document.getElementById('playlistPreviewCard').style.display = 'none';
        const spotifyCard = document.getElementById('spotifyPreviewCard');
        spotifyCard.style.display = 'none';
        document.getElementById('spotifyLogs').innerHTML = '';
        document.getElementById('spotifyPreviewList').innerHTML = '';

        const convertMatchedBtn = document.getElementById('convertMatchedBtn');
        if (convertMatchedBtn) {
            convertMatchedBtn.style.display = 'none';
        }

        if (this.app.spotifyManager.spotifyEventSource) {
            this.app.spotifyManager.spotifyEventSource.close();
            this.app.spotifyManager.spotifyEventSource = null;
        }
        if (this.previewAbort) {
            try { this.previewAbort.abort(); } catch { }
            this.previewAbort = null;
        }

        this.currentPreview = {
            url: null, items: [], selected: new Set(),
            title: '', count: 0, page: 1, pageSize: 50,
            isSpotify: false, streaming: false,
            indexToId: new Map(),
            indexToTitle: new Map(),
            indexToUploader: new Map(),
            indexToDuration: new Map(),
            indexToWebpageUrl: new Map()
        };
        this.app.spotifyManager.currentSpotifyTask = {
            id: null,
            jobId: null,
            completed: false
        };

        const logEl = document.getElementById('plStreamLog');
        if (logEl) { logEl.style.display = 'none'; logEl.textContent = ''; }
    }
}
