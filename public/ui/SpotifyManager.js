export class SpotifyManager {
    constructor(app) {
        this.app = app;
        this.currentSpotifyTask = {
            id: null,
            jobId: null,
            completed: false
        };
        this.spotifyEventSource = null;
        this.integratedRenderedCount = 0;
    }

    async startSpotifyPreview() {
        const url = document.getElementById('urlInput').value.trim();
        if (!url) {
            this.app.showNotification(this.app.t('notif.needUrl'), 'error', 'error');
            return;
        }

        try {
            const btn = document.getElementById('startSpotifyBtn');
            btn.classList.add('btn-loading');
            btn.disabled = true;

            const response = await fetch('/api/spotify/preview/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const code = error?.error?.code;
                const msg = code ? this.app.t(`errors.${code}`) : (error?.error?.message || this.app.t('errors.startFailed'));
                throw new Error(msg);
            }

            const data = await response.json();
            this.currentSpotifyTask.id = data.mapId;

            document.getElementById('spotifyTitle').textContent = data.title || '-';
            document.getElementById('spotifyTotal').textContent = data.total || 0;
            document.getElementById('spotifyStatus').style.display = 'block';
            document.getElementById('spotifyStatusText').textContent = this.app.t('status.mappingStarted');

            this.streamSpotifyLogs(data.mapId);

        } catch (error) {
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        } finally {
            const btn = document.getElementById('startSpotifyBtn');
            btn.classList.remove('btn-loading');
            btn.disabled = false;
        }
    }

    showSpotifyPreview(data) {
        this.app.previewManager.hidePreview();

        document.getElementById('spotifyPreviewCard').style.display = 'block';
        document.getElementById('spotifyTitle').textContent = data.title;
        document.getElementById('spotifyTotal').textContent = data.total;
        document.getElementById('spotifyMatched').textContent = '0';
        document.getElementById('spotifyProgress').textContent = '0%';
        document.getElementById('urlSpotifyActions').style.display = 'none';
        document.getElementById('spotifyStartActions').style.display = 'flex';
        document.getElementById('spotifyConvertActions').style.display = 'none';
        document.getElementById('spotifyDownloadSection').style.display = 'none';
        document.getElementById('spotifyLogs').innerHTML = '';
        document.getElementById('spotifyPreviewList').innerHTML = '';
        document.getElementById('spotifyDownloadList').innerHTML = '';
    }

    streamSpotifyLogs(mapId) {
        if (this.spotifyEventSource) {
            this.spotifyEventSource.close();
        }

        this.spotifyEventSource = new EventSource(`/api/spotify/preview/stream-logs/${mapId}`);
        const logsContainer = document.getElementById('spotifyLogs');
        const listContainer = document.getElementById('spotifyPreviewList');

        this.spotifyEventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'init':
                    document.getElementById('spotifyTitle').textContent = data.title || '-';
                    document.getElementById('spotifyTotal').textContent = data.total || 0;
                    if (data.items && Array.isArray(data.items)) {
                        data.items.forEach(item => this.addSpotifyItem(item));
                    }
                    break;

                case 'item':
                    this.addSpotifyItem(data.item);
                    if (data.logKey || data.log) {
                        const msg = data.logKey ? this.app.t(data.logKey, data.logVars || {}) : this.app.normalizeLog(data.log);
                        this.addLogEntry(msg, 'success');
                    }
                    break;

                case 'progress':
                    this.updateSpotifyProgress(data.done, data.total);
                    break;

                case 'log':
                    {
                        const msg = data.logKey
                            ? this.app.t(data.logKey, data.logVars || {})
                            : this.app.normalizeLog(data.message);
                        this.addLogEntry(msg, data.level || 'info');
                    }
                    break;

                case 'done':
                    {
                        const msg = data.logKey
                            ? this.app.t(data.logKey, data.logVars || {})
                            : this.app.normalizeLog(data.log || this.app.t('status.completed'));
                        this.addLogEntry(msg, data.status === 'completed' ? 'success' : 'error');

                        if (data.status === 'completed') {
                            this.addLogEntry(this.app.t('status.allMatchesCompleted'), 'success');
                            this.onSpotifyMappingCompleted();
                        }
                        if (data.status === 'completed' || data.status === 'error') {
                            this.spotifyEventSource.close();
                        }
                    }
                    break;
            }
        };

        this.spotifyEventSource.onerror = (error) => {
            this.addLogEntry(this.app.t('errors.connectionError'), 'error');
            this.spotifyEventSource.close();
        };
    }

    addSpotifyItem(item) {
        const listContainer = document.getElementById('spotifyPreviewList');
        const matched = item.id !== null;

        const itemElement = document.createElement('div');
        itemElement.className = `spotify-track-item ${matched ? 'matched' : 'unmatched'}`;
        if (matched) {
            itemElement.dataset.ytId = item.id;
        }

        itemElement.innerHTML = `
            <div class="track-status">${matched ? '✅' : '❌'}</div>
            <div class="track-info">
                <div class="track-title">${item.index}. ${this.app.escapeHtml(item.title)}</div>
                <div class="track-artist">${this.app.escapeHtml(item.uploader)}</div>
            </div>
            ${matched ? `<div class="progress-bar-mini"><div class="progress-fill-mini" style="width: 0%"></div></div>` : ''}
        `;

        listContainer.appendChild(itemElement);
        const matchedCount = listContainer.querySelectorAll('.matched').length;
        document.getElementById('spotifyMatched').textContent = matchedCount;
    }

    addLogEntry(message, level = 'info') {
        const logsContainer = document.getElementById('spotifyLogs');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${level}`;
        const timestamp = new Date().toLocaleTimeString();
        logEntry.textContent = `[${timestamp}] ${this.app.normalizeLog(message)}`;
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    updateSpotifyProgress(done, total) {
        const progress = total > 0 ? Math.round((done / total) * 100) : 0;
        document.getElementById('spotifyProgress').textContent = `${progress}%`;
        document.querySelectorAll('.progress-fill-mini').forEach(bar => {
            bar.style.width = `${progress}%`;
        });
    }

    onSpotifyMappingCompleted() {
        this.currentSpotifyTask.completed = true;

        document.getElementById('spotifyStatusText').textContent = this.app.t('status.mappingCompleted');
        const convertMatchedBtn = document.getElementById('convertMatchedBtn');
        if (convertMatchedBtn) {
            convertMatchedBtn.style.display = 'inline-block';
        }
    }

    async startIntegratedSpotifyProcess() {
    const url = document.getElementById('urlInput').value.trim();
    const format = document.getElementById('formatSelect').value;
    const bitrate = document.getElementById('bitrateSelect').value;
    const sampleRate = document.getElementById('sampleRateSelect').value;
    const includeLyrics = document.getElementById('lyricsCheckbox').checked;
    const videoSettings = this.app.videoManager?.getSettings() || {};
    const bitDepthSelect = document.getElementById('bitDepthSelect');

    let bitDepth = null;
    if (bitDepthSelect && (format === 'flac' || format === 'wav')) {
        bitDepth = bitDepthSelect.value || null;
    }

    let compressionLevel;
    const compEl = document.getElementById('compressionLevelRange');
    if (format === 'flac' && compEl) {
        const v = parseInt(compEl.value, 10);
        if (Number.isFinite(v)) {
            compressionLevel = v;
        }
    }

    if (!url) {
        this.app.showNotification(this.app.t('notif.needUrl'), 'error', 'error');
        return;
    }

    try {
        const btn = document.getElementById('startIntegratedBtn');
        btn.classList.add('btn-loading');
        btn.disabled = true;

        document.getElementById('spotifyPreviewCard').style.display = 'block';
        document.getElementById('spotifyTitle').textContent = this.app.t('status.starting');
        document.getElementById('spotifyTotal').textContent = '0';
        document.getElementById('spotifyMatched').textContent = '0';
        document.getElementById('spotifyProgress').textContent = '0%';
        document.getElementById('spotifyLogs').innerHTML = '';
        const listEl = document.getElementById('spotifyPreviewList');
        if (listEl) listEl.innerHTML = '';
        this.integratedRenderedCount = 0;

        const isVideoFormat = format === 'mp4' || format === 'mkv';
        const body = {
            url,
            format,
            bitrate,
            sampleRate,
            includeLyrics,
            volumeGain: this.app.currentVolumeGain || 1.0,
            ...(compressionLevel != null ? { compressionLevel } : {}),
            ...(bitDepth != null ? { bitDepth } : {}),
            ...(isVideoFormat ? { videoSettings } : {})
        };

        const response = await fetch('/api/spotify/process/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const code = error?.error?.code;
            const msg = code
                ? this.app.t(`errors.${code}`)
                : (error?.error?.message || this.app.t('errors.startFailed'));
            throw new Error(msg);
        }

        const data = await response.json();
        document.getElementById('spotifyTitle').textContent = data.title || '-';
        document.getElementById('spotifyTotal').textContent = data.total || '0';

        this.app.jobManager.trackJob(data.jobId);
        this.app.showNotification(this.app.t('notif.queue'), 'success', 'queue');
        this.streamIntegratedLogs(data.jobId);

    } catch (error) {
        this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        document.getElementById('spotifyLogs').innerHTML +=
            `<div class="log-entry error">[${new Date().toLocaleTimeString()}] ❌ ${this.app.t('notif.errorPrefix')}: ${this.app.escapeHtml(error.message)}</div>`;
    } finally {
        const btn = document.getElementById('startIntegratedBtn');
        btn.classList.remove('btn-loading');
        btn.disabled = false;
    }
}

    streamIntegratedLogs(jobId) {
        const eventSource = new EventSource(`/api/stream/${jobId}`);
        const logsContainer = document.getElementById('spotifyLogs');

        eventSource.onmessage = (event) => {
            const job = JSON.parse(event.data);

            if (job.progress) {
                document.getElementById('spotifyProgress').textContent = `${job.progress}%`;
            }

            (() => {
                try {
                    let line = '';
                    if (job && job.__event && job.type === 'skip-hint') {
                        if (job.lastLogKey) line = this.app.t(job.lastLogKey, job.lastLogVars || {});
                        else if (job.raw) line = this.app.normalizeBackendLog(job.raw);
                        else if (job.message) line = this.app.normalizeBackendLog(job.message);
                    } else if (typeof job.raw === 'string' && /SKIP_(HINT|SUMMARY):/i.test(job.raw)) {
                        line = this.app.normalizeBackendLog(job.raw);
                    }
                    if (line) {
                        this.addLogEntry(line, 'warning');
                    }
                } catch (_) { }
            })();

            if (job.playlist) {
                document.getElementById('spotifyMatched').textContent = `${job.playlist.done || 0}/${job.playlist.total || 0}`;
            }

            if (job.phase || job.lastLog || job.lastLogKey) {
                const phaseText = {
                    mapping: this.app.t('phase.mapping'),
                    downloading: this.app.t('phase.downloading'),
                    converting: this.app.t('phase.converting'),
                    completed: this.app.t('phase.completed'),
                    error: this.app.t('phase.error')
                };

                if (typeof job.lastLog === 'string') {
                    job.lastLog = this.app.normalizeBackendLog(job.lastLog);
                }

                const logEntry = document.createElement('div');
                logEntry.className = `log-entry ${job.phase === 'error' ? 'error' : 'info'}`;

                const timestamp = new Date().toLocaleTimeString();

                if (job.lastLogKey) {
                    logEntry.textContent = `[${timestamp}] ${this.app.t(job.lastLogKey, job.lastLogVars || {})}`;
                } else if (job.lastLog) {
                    const txt = (typeof job.lastLog === 'string' && (job.lastLog.startsWith('log.') || job.lastLog.startsWith('phase.') || job.lastLog.startsWith('status.')))
                        ? this.app.t(job.lastLog, job.lastLogVars || {})
                        : job.lastLog;
                    logEntry.textContent = `[${timestamp}] ${txt}`;
                } else if (job.phase) {
                    logEntry.textContent = `[${timestamp}] ${phaseText[job.phase] || job.phase}`;
                }

                logsContainer.appendChild(logEntry);
                logsContainer.scrollTop = logsContainer.scrollHeight;
            }

            if (job?.metadata?.frozenEntries && Array.isArray(job.metadata.frozenEntries)) {
                const arr = job.metadata.frozenEntries;
                for (let i = this.integratedRenderedCount; i < arr.length; i++) {
                    this.addSpotifyItem(arr[i]);
                }
                this.integratedRenderedCount = arr.length;
                const matchedCount = document.getElementById('spotifyPreviewList')
                    .querySelectorAll('.matched').length;
                document.getElementById('spotifyMatched').textContent = matchedCount;
            }
        };

        eventSource.onerror = (error) => {
            console.error('Entegre log SSE error:', error);
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry error';
            logEntry.textContent = `[${new Date().toLocaleTimeString()}] ❌ ${this.app.t('errors.streamDisconnected')}`;
            logsContainer.appendChild(logEntry);
            logsContainer.scrollTop = logsContainer.scrollHeight;
            eventSource.close();
        };
    }

    updateSpotifyPreviewList(entries) {
        const listContainer = document.getElementById('spotifyPreviewList');
        listContainer.innerHTML = '';

        entries.forEach((item, index) => {
            const matched = item.id !== null;

            const itemElement = document.createElement('div');
            itemElement.className = `spotify-track-item ${matched ? 'matched' : 'unmatched'}`;
            if (matched) {
                itemElement.dataset.ytId = item.id;
            }

            itemElement.innerHTML = `
                <div class="track-status">${matched ? '✅' : '❌'}</div>
                <div class="track-info">
                    <div class="track-title">${item.index}. ${this.app.escapeHtml(item.title)}</div>
                    <div class="track-artist">${this.app.escapeHtml(item.uploader)}</div>
                </div>
                ${matched ? `<div class="progress-bar-mini"><div class="progress-fill-mini" style="width: 0%"></div></div>` : ''}
            `;

            listContainer.appendChild(itemElement);
        });

        const matchedCount = listContainer.querySelectorAll('.matched').length;
        document.getElementById('spotifyMatched').textContent = matchedCount;
    }

    async convertMatchedSpotify() {
    if (!this.currentSpotifyTask.id) {
        this.app.showNotification(this.app.t('notif.spotifyMappingFirst'), 'error', 'error');
        return;
    }

    try {
        const format = document.getElementById('formatSelect').value;
        const bitrate = document.getElementById('bitrateSelect').value;
        const sampleRate = document.getElementById('sampleRateSelect').value;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;
        const videoSettings = this.app.videoManager?.getSettings() || {};
        const isVideoFormat = format === 'mp4' || format === 'mkv';
        const compressionLevel =
            format === 'flac'
                ? (document.getElementById('compressionLevelRange')?.value || '5')
                : undefined;

        const validItems = this.getCurrentSpotifyMatchedItems();
        if (validItems.length === 0) {
            this.app.showNotification(this.app.t('notif.noMatchedTracks'), 'error', 'error');
            return;
        }

        const payload = {
            url: document.getElementById('urlInput').value.trim(),
            format,
            bitrate,
            sampleRate: sampleRate,
            isPlaylist: true,
            volumeGain: this.app.currentVolumeGain || 1.0,
            ...(compressionLevel !== undefined ? { compressionLevel } : {}),
            ...(isVideoFormat ? { videoSettings } : {}),
            selectedIndices: validItems.map(item => item.index),
            spotifyMapId: this.currentSpotifyTask.id,
            metadata: {
                source: "spotify",
                spotifyTitle: document.getElementById('spotifyTitle').textContent,
                selectedIds: validItems.map(item => item.id),
                frozenEntries: validItems,
                spotifyMapId: this.currentSpotifyTask.id,
                includeLyrics,
                volumeGain: this.app.currentVolumeGain || 1.0
            }
        };

        document.getElementById('spotifyStatusText').textContent = this.app.t('status.conversionStarting');

        const jobId = await this.submitSpotifyJob(payload);

        if (jobId) {
            this.currentSpotifyTask.jobId = jobId;
            document.getElementById('spotifyStatusText').textContent = this.app.t('status.conversionStarted');
            this.app.showNotification(this.app.t('notif.tracksQueued', { count: validItems.length }), 'success', 'queue');
            this.app.jobManager.trackJob(jobId);
        }

    } catch (error) {
        this.app.showNotification(`${this.app.t('notif.conversionError')}: ${error.message}`, 'error', 'error');
        document.getElementById('spotifyStatusText').textContent = this.app.t('status.conversionFailed');
    }
}

    getCurrentSpotifyMatchedItems() {
        const validItems = [];
        const listItems = document.querySelectorAll('.spotify-track-item.matched');

        listItems.forEach(item => {
            const titleEl = item.querySelector('.track-title');
            const artistEl = item.querySelector('.track-artist');
            if (titleEl && artistEl) {
                const title = titleEl.textContent.replace(/^\d+\.\s/, '');
                const artist = artistEl.textContent;
                const index = parseInt(titleEl.textContent.match(/^(\d+)\./)?.[1]) || validItems.length + 1;
                const ytId = item.dataset.ytId || `spotify_${index}_${Date.now()}`;

                validItems.push({
                    title,
                    uploader: artist,
                    index: index,
                    id: ytId
                });
            }
        });
        return validItems;
    }

    async getValidSpotifyItems() {
        const validItems = [];
        const listItems = document.querySelectorAll('.spotify-track-item.matched');

        listItems.forEach(item => {
            const titleEl = item.querySelector('.track-title');
            const artistEl = item.querySelector('.track-artist');
            if (titleEl && artistEl) {
                const title = titleEl.textContent.replace(/^\d+\.\s/, '');
                const artist = artistEl.textContent;
                const index = parseInt(titleEl.textContent.match(/^(\d+)\./)?.[1]) || validItems.length + 1;
                const tempId = `spotify_${index}_${Date.now()}`;

                validItems.push({
                    title,
                    uploader: artist,
                    index: index,
                    id: tempId
                });
            }
        });
        return validItems;
    }

    async submitSpotifyJob(payload) {
        try {
            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const e = await response.json().catch(() => ({}));
                throw new Error(e?.error?.message || this.app.t('errors.jobCreationFailed'));
            }

            const result = await response.json();
            return result.id;

        } catch (error) {
            console.error('Spotify job submission error:', error);
            throw error;
        }
    }
}
