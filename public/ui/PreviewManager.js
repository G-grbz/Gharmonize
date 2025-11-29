export class PreviewManager {
    constructor(app) {
        this.app = app;
        this.currentPreview = {
            url: null, items: [], selected: new Set(),
            title: '', count: 0, page: 1, pageSize: 25,
            isSpotify: false, streaming: false,
            indexToId: new Map(),
            indexToTitle: new Map()
        };
        this.previewAbort = null;
    }

    async handlePreviewClick() {
        const url = document.getElementById('urlInput').value.trim();
        if (this.app.isSpotifyUrl(url)) {
            this.app.spotifyManager.startSpotifyPreview();
        } else {
            this.previewPlaylist();
        }
    }

    async previewPlaylist() {
        const url = document.getElementById('urlInput').value.trim();
        const isPlaylist = document.getElementById('playlistCheckbox').checked;
        const btn = document.getElementById('previewBtn');
        if (!url) {
            this.app.showNotification(this.app.t('notif.needUrl'), 'error', 'error');
            return;
        }
        if (this.app.isSpotifyUrl(url)) {
            try {
                btn?.classList.add('btn-loading');
                btn?.setAttribute('disabled', 'disabled');
                btn.textContent = this.app.t('ui.loading');
                const batchSize = Number(document.getElementById('pageSizeSel').value) || 10;
                await this.streamPreviewByPaging(url, Math.max(1, Math.min(50, batchSize)));
            } catch (e) {
                this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${e.message}`, 'error', 'error');
            } finally {
                btn?.classList.remove('btn-loading');
                btn?.removeAttribute('disabled');
                btn.textContent = this.app.t('btn.preview');
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
        }
    }

    async streamPreviewByPaging(url, batchSize) {
        this.currentPreview.url = url;
        this.currentPreview.isSpotify = true;
        this.currentPreview.streaming = true;
        this.currentPreview.selected = new Set();
        this.currentPreview.items = [];
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

    appendPreviewItems(items) {
        const listEl = document.getElementById('previewList');
        for (const item of items) {
            this.currentPreview.items.push(item);
            if (item && Number.isFinite(item.index) && item.id) {
                this.currentPreview.indexToId.set(item.index, item.id);
            }
            if (item && Number.isFinite(item.index) && item.title) {
                this.currentPreview.indexToTitle.set(item.index, item.title);
            }
            const row = document.createElement('div');
            row.className = 'preview-row';
            row.innerHTML = `
                <img class="preview-thumb" src="${item.thumbnail || ''}" alt="thumb" onerror="this.style.display='none'" />
                <div>
                    <div class="preview-title">${item.index}. ${this.app.escapeHtml(item.title || '')}</div>
                    <div class="muted">${this.app.escapeHtml(item.uploader || '')}</div>
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
            if (item && Number.isFinite(item.index) && item.id) {
                this.currentPreview.indexToId.set(item.index, item.id);
            }
            if (item && Number.isFinite(item.index) && item.title) {
                this.currentPreview.indexToTitle.set(item.index, item.title);
            }
            const row = document.createElement('div');
            row.className = 'preview-row';
            row.innerHTML = `
                <img class="preview-thumb" src="${item.thumbnail || ''}" alt="thumb" onerror="this.style.display='none'" />
                <div>
                    <div class="preview-title">${item.index}. ${this.app.escapeHtml(item.title || '')}</div>
                    <div class="muted">${this.app.escapeHtml(item.uploader || '')}</div>
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

    async convertSelected() {
        if (!this.currentPreview.url) {
            this.app.showNotification(this.app.t('notif.previewFirst'), 'error', 'error');
            return;
        }

        const selected = Array.from(this.currentPreview.selected);
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
            const volumeGain = this.app.currentVolumeGain || 1.0;
            const compressionLevel =
            format === 'flac'
                ? (document.getElementById('compressionLevelRange')?.value || '5')
                : undefined;
            const selectedIds = selected
                .map(i => this.currentPreview.indexToId.get(i))
                .filter(Boolean);

            console.log("Seçilen ID'ler:", selectedIds);

            if (sequential && selected.length > 1) {
                const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
                this.app.jobManager.ensureBatch(batchId, selected.length, { format, bitrate, source: this.app.t('ui.youtubePlaylist') });
                for (const idx of selected) {
                    const idFromMap = this.currentPreview.indexToId.get(idx);
                    const itemId = idFromMap ? [idFromMap] : null;

                    await this.app.jobManager.submitJob({
                        url: this.currentPreview.url,
                        isPlaylist: true,
                        selectedIndices: [idx],
                        selectedIds: itemId,
                        format,
                        bitrate,
                        sampleRate: sampleRate,
                        clientBatch: batchId,
                        includeLyrics,
                        volumeGain
                    });
                }
            } else {
                await this.app.jobManager.submitJob({
                    url: this.currentPreview.url,
                    isPlaylist: true,
                    selectedIndices: selected,
                    selectedIds: selectedIds.length ? selectedIds : null,
                    format,
                    bitrate,
                    sampleRate: sampleRate,
                    includeLyrics,
                    volumeGain
                });
            }

            this.app.showNotification(this.app.t('notif.tracksQueued', { count: selected.length }), 'success', 'queue');

        } catch (error) {
            console.error('Seçilenleri dönüştürme hatası:', error);
            this.app.showNotification(`${this.app.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        } finally {
            convertBtn.classList.remove('btn-loading');
            convertBtn.disabled = false;
            convertBtn.textContent = originalText;
        }
    }

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
            const volumeGain = this.app.currentVolumeGain || 1.0;
            const allIds = this.currentPreview.items.map(item => item.id).filter(Boolean);

            await this.app.jobManager.submitJob({
                url: this.currentPreview.url,
                isPlaylist: true,
                selectedIndices: 'all',
                selectedIds: allIds,
                format,
                bitrate,
                sampleRate: sampleRate,
                includeLyrics,
                volumeGain
            });

            this.app.showNotification(this.app.t('notif.allTracksQueued'), 'success', 'queue');

        } catch (error) {
            console.error('Tümünü dönüştürme hatası:', error);
            this.app.showNotification(`${this.app.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        } finally {
            convertAllBtn.classList.remove('btn-loading');
            convertAllBtn.disabled = false;
            convertAllBtn.textContent = originalText;
        }
    }

    showPreview() {
        document.getElementById('spotifyPreviewCard').style.display = 'none';
        document.getElementById('playlistPreviewCard').style.display = 'block';
    }

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
            indexToTitle: new Map()
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
