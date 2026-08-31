export class SpotifyManager {
    // Initializes class state and defaults for Spotify mapping and metadata flow.
    constructor(app) {
        this.app = app;
        this.currentSpotifyTask = {
            id: null,
            jobId: null,
            completed: false,
            source: 'spotify'
        };
        this.spotifyEventSource = null;
        this.integratedEventSource = null;
        this.integratedRenderedIndexes = new Set();
        this.lastIntegratedMatched = 0;
        this.lastIntegratedMappingProgress = 0;
        this.lastIntegratedLogSignature = '';
    }

    getSpotifyConcurrency() {
        const v = parseInt(document.getElementById('spotifyConcurrencyInput')?.value || '4', 10);
        if (!Number.isFinite(v) || v <= 0) return 4;
        return Math.max(1, Math.min(16, Math.round(v)));
    }

    // Handles start Spotify metadata preview in Spotify mapping and metadata flow.
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
                body: JSON.stringify({
                    url,
                    spotifyConcurrency: this.getSpotifyConcurrency()
                })
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                const code = error?.error?.code;
                const msg = code ? this.app.t(`errors.${code}`) : (error?.error?.message || this.app.t('errors.startFailed'));
                throw new Error(msg);
            }

            const data = await response.json();
            this.currentSpotifyTask.id = data.mapId;
            this.currentSpotifyTask.jobId = null;
            this.currentSpotifyTask.completed = false;
            this.currentSpotifyTask.source = data.source || 'spotify';

            document.getElementById('spotifyTitle').textContent = data.title || '-';
            document.getElementById('spotifyTotal').textContent = data.total || 0;
            document.getElementById('spotifyMatched').textContent = '0';
            document.getElementById('spotifyProgress').textContent = '0%';
            const previewList = document.getElementById('spotifyPreviewList');
            if (previewList) previewList.innerHTML = '';
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

    // Shows Spotify metadata preview in Spotify mapping and metadata flow.
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

    // Streams Spotify metadata logs in Spotify mapping and metadata flow.
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
                        data.items.filter(Boolean).forEach(item => this.addSpotifyItem(item));
                    }
                    if (Number.isFinite(Number(data.matched))) {
                        document.getElementById('spotifyMatched').textContent = String(Number(data.matched));
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
                    if (Number.isFinite(Number(data.matched))) {
                        document.getElementById('spotifyMatched').textContent = String(Number(data.matched));
                    }
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

    // Handles add Spotify metadata item in Spotify mapping and metadata flow.
    addSpotifyItem(item) {
        if (!item) return;
        const listContainer = document.getElementById('spotifyPreviewList');
        const matched = !!item.id;
        const trackKey = String(item.index ?? '');
        if (trackKey && listContainer.querySelector(`[data-track-index="${CSS.escape(trackKey)}"]`)) return;

        const itemElement = document.createElement('div');
        if (trackKey) itemElement.dataset.trackIndex = trackKey;
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
        // The server is authoritative for the matched count. During async
        // mapping the DOM can lag behind the backend, so counting rendered
        // rows here can make the UI jump backwards (for example 200 -> 190).
    }

    // Handles add log entry in Spotify mapping and metadata flow.
    addLogEntry(message, level = 'info') {
        const logsContainer = document.getElementById('spotifyLogs');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${level}`;
        const timestamp = new Date().toLocaleTimeString();
        logEntry.textContent = `[${timestamp}] ${this.app.normalizeLog(message)}`;
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    // Updates Spotify metadata progress for Spotify mapping and metadata flow.
    updateSpotifyProgress(done, total) {
        const progress = total > 0 ? Math.round((done / total) * 100) : 0;
        document.getElementById('spotifyProgress').textContent = `${progress}%`;
        document.querySelectorAll('.progress-fill-mini').forEach(bar => {
            bar.style.width = `${progress}%`;
        });
    }

    // Handles on Spotify metadata mapping completed in Spotify mapping and metadata flow.
    onSpotifyMappingCompleted() {
        this.currentSpotifyTask.completed = true;

        document.getElementById('spotifyStatusText').textContent = this.app.t('status.mappingCompleted');
        const convertMatchedBtn = document.getElementById('convertMatchedBtn');
        if (convertMatchedBtn) {
            convertMatchedBtn.style.display = 'inline-block';
        }
    }

    // Handles start integrated Spotify metadata process in Spotify mapping and metadata flow.
    async startIntegratedSpotifyProcess(options = {}) {
        // Direct calls always process only the URL explicitly supplied (or #urlInput).
        // The saved URL queue is intentionally started only from its own modal action.
        const url = String(options.url ?? document.getElementById('urlInput')?.value ?? '').trim();
        const outputSettings = this.app.resolveCurrentOutputSettings();
        const format = outputSettings.format;
        const bitrate = outputSettings.bitrate;
        const sampleRate = outputSettings.sampleRate;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;
        const embedLyrics = !!document.getElementById('embedLyricsCheckbox')?.checked;
        const videoSettings = this.app.videoManager?.getSettings() || {};
        const audioProcessing = this.app.getCurrentAudioProcessingSettings();
        const bitDepthSelect = document.getElementById('bitDepthSelect');
        const manageButton = !options.queueManaged;

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
            return { status: 'error', error: this.app.t('notif.needUrl') };
        }

        try {
            const btn = document.getElementById('startIntegratedBtn');
            if (manageButton && btn) {
                btn.classList.add('btn-loading');
                btn.disabled = true;
            }

            document.getElementById('spotifyPreviewCard').style.display = 'block';
            document.getElementById('spotifyTitle').textContent = this.app.t('status.starting');
            document.getElementById('spotifyTotal').textContent = '0';
            document.getElementById('spotifyMatched').textContent = '0';
            document.getElementById('spotifyProgress').textContent = '0%';
            document.getElementById('spotifyLogs').innerHTML = '';
            const listEl = document.getElementById('spotifyPreviewList');
            if (listEl) listEl.innerHTML = '';
            this.integratedRenderedIndexes = new Set();
            this.lastIntegratedMatched = 0;
            this.lastIntegratedMappingProgress = 0;
            this.lastIntegratedLogSignature = '';

            const isVideoFormat = format === 'mp4' || format === 'mkv';
            const spotifyConcurrency = this.getSpotifyConcurrency();
            const autoCreateZip = !isVideoFormat && this.app.autoCreateZip;

            const body = {
                url,
                format,
                bitrate,
                sampleRate,
                includeLyrics,
                embedLyrics,
                ...audioProcessing,
                autoCreateZip,
                ringtone: outputSettings.ringtone,
                ...(compressionLevel != null ? { compressionLevel } : {}),
                ...(bitDepth != null ? { bitDepth } : {}),
                ...(isVideoFormat ? { videoSettings } : {}),
                spotifyConcurrency
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
            this.currentSpotifyTask.jobId = data.jobId;
            this.currentSpotifyTask.completed = false;
            document.getElementById('spotifyTitle').textContent = data.title || '-';
            document.getElementById('spotifyTotal').textContent = data.total || '0';

            this.app.jobManager.trackJob(data.jobId);
            this.app.showNotification(this.app.t('notif.queue'), 'success', 'queue');

            const terminalPromise = this.streamIntegratedLogs(data.jobId, {
                waitForTerminal: !!options.awaitCompletion
            });

            if (options.awaitCompletion) {
                const job = await terminalPromise;
                const terminalStatus = String(job?.phase || job?.status || '').toLowerCase();
                return {
                    status: terminalStatus === 'completed'
                        ? 'completed'
                        : terminalStatus === 'canceled'
                            ? 'canceled'
                            : 'error',
                    error: job?.error || null,
                    jobId: data.jobId,
                    job
                };
            }

            return { status: 'started', jobId: data.jobId };
        } catch (error) {
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
            const logs = document.getElementById('spotifyLogs');
            if (logs) {
                logs.innerHTML += `<div class="log-entry error">[${new Date().toLocaleTimeString()}] ❌ ${this.app.t('notif.errorPrefix')}: ${this.app.escapeHtml(error.message)}</div>`;
            }
            return { status: 'error', error: error.message };
        } finally {
            if (manageButton) {
                const btn = document.getElementById('startIntegratedBtn');
                btn?.classList.remove('btn-loading');
                if (btn) btn.disabled = false;
            }
        }
    }

    // Streams integrated logs in Spotify mapping and metadata flow.
    streamIntegratedLogs(jobId, { waitForTerminal = false } = {}) {
        if (this.integratedEventSource) {
            try { this.integratedEventSource.close(); } catch (_) {}
        }

        const eventSource = new EventSource(`/api/stream/${jobId}`);
        this.integratedEventSource = eventSource;
        const logsContainer = document.getElementById('spotifyLogs');
        let finished = false;
        let resolved = false;
        let resolveTerminal;
        const terminalPromise = new Promise((resolve) => {
            resolveTerminal = resolve;
        });

        const isTerminal = (job) => {
            const phase = String(job?.phase || job?.status || '').toLowerCase();
            return phase === 'completed' || phase === 'error' || phase === 'canceled';
        };

        const finish = (job) => {
            if (resolved) return;
            resolved = true;
            finished = true;
            this.currentSpotifyTask.completed = String(job?.phase || job?.status || '').toLowerCase() === 'completed';
            try { eventSource.close(); } catch (_) {}
            if (this.integratedEventSource === eventSource) this.integratedEventSource = null;
            resolveTerminal(job || { phase: 'error', error: this.app.t('musicQueue.unknownError') });
        };

        eventSource.onmessage = (event) => {
            // Ignore stale events from an older integrated job.
            if (this.currentSpotifyTask.jobId && this.currentSpotifyTask.jobId !== jobId) return;
            const job = JSON.parse(event.data);

            try {
                const titleEl = document.getElementById('spotifyTitle');
                const totalEl = document.getElementById('spotifyTotal');
                const matchedEl = document.getElementById('spotifyMatched');

                const spTitle = job?.metadata?.frozenTitle || job?.metadata?.spotifyTitle;
                const spTotalRaw = job?.playlist?.total;
                const spTotal = Number(spTotalRaw);
                const liveMatched = Number(job?.playlist?.matched);
                const matchedCount = Number.isFinite(liveMatched)
                    ? Math.max(0, Math.min(Number.isFinite(spTotal) ? spTotal : liveMatched, liveMatched))
                    : (Array.isArray(job?.metadata?.frozenEntries)
                        ? job.metadata.frozenEntries.filter(Boolean).length
                        : 0);

                if (spTitle && titleEl && (titleEl.textContent === '-' || titleEl.textContent === this.app.t('status.starting') || !titleEl.textContent)) {
                    titleEl.textContent = spTitle;
                }

                if (Number.isFinite(spTotal) && spTotal >= 0 && totalEl) {
                    totalEl.textContent = String(spTotal);
                }

                if (matchedEl) {
                    // Matching is monotonic for a job. Never let a stale snapshot
                    // or a lagging rendered list reduce the visible count.
                    this.lastIntegratedMatched = Math.max(this.lastIntegratedMatched, matchedCount);
                    matchedEl.textContent = String(this.lastIntegratedMatched);
                }
            } catch (_) {}

            // This card is the matching card, so show mapping progress rather
            // than the mixed download/convert job progress. Download and convert
            // start early and can otherwise make this value jump 85% -> 17%.
            const mappingProgressRaw = Number(job?.playlist?.mappingProgress);
            if (Number.isFinite(mappingProgressRaw) && mappingProgressRaw >= 0) {
                const mappingProgress = Math.max(0, Math.min(100, Math.floor(mappingProgressRaw)));
                this.lastIntegratedMappingProgress = Math.max(this.lastIntegratedMappingProgress, mappingProgress);
                document.getElementById('spotifyProgress').textContent = `${this.lastIntegratedMappingProgress}%`;
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
                } catch (_) {}
            })();

            if (job.phase || job.lastLog || job.lastLogKey) {
                const phaseText = {
                    preparing: this.app.t('phase.preparing'),
                    mapping: this.app.t('phase.mapping'),
                    downloading: this.app.t('phase.downloading'),
                    converting: this.app.t('phase.converting'),
                    completed: this.app.t('phase.completed'),
                    canceled: this.app.t('status.canceled'),
                    error: this.app.t('phase.error')
                };

                if (typeof job.lastLog === 'string') {
                    job.lastLog = this.app.normalizeBackendLog(job.lastLog);
                }

                const timestamp = new Date().toLocaleTimeString();
                let text = '';

                if (job.lastLogKey) {
                    text = this.app.t(job.lastLogKey, job.lastLogVars || {});
                } else if (job.lastLog) {
                    text = (typeof job.lastLog === 'string' && (job.lastLog.startsWith('log.') || job.lastLog.startsWith('phase.') || job.lastLog.startsWith('status.')))
                        ? this.app.t(job.lastLog, job.lastLogVars || {})
                        : job.lastLog;
                } else if (job.phase) {
                    text = phaseText[job.phase] || job.phase;
                }

                const signature = JSON.stringify({
                    phase: job.phase || '',
                    key: job.lastLogKey || '',
                    vars: job.lastLogVars || null,
                    text
                });

                if (text && signature !== this.lastIntegratedLogSignature && logsContainer) {
                    this.lastIntegratedLogSignature = signature;
                    const logEntry = document.createElement('div');
                    logEntry.className = `log-entry ${job.phase === 'error' ? 'error' : 'info'}`;
                    logEntry.textContent = `[${timestamp}] ${text}`;
                    logsContainer.appendChild(logEntry);
                    logsContainer.scrollTop = logsContainer.scrollHeight;
                }
            }

            if (job?.metadata?.frozenEntries && Array.isArray(job.metadata.frozenEntries)) {
                const arr = job.metadata.frozenEntries;
                // frozenEntries is intentionally sparse while parallel matching
                // is in flight. A high index may arrive before a low index, so
                // never use array.length as a rendered cursor.
                arr.forEach((item, index) => {
                    if (!item || this.integratedRenderedIndexes.has(index)) return;
                    this.addSpotifyItem(item);
                    this.integratedRenderedIndexes.add(index);
                });
            }

            if (isTerminal(job)) finish(job);
        };

        eventSource.onerror = async (error) => {
            if (finished) {
                try { eventSource.close(); } catch (_) {}
                return;
            }

            console.error('Integrated log SSE error:', error);
            if (logsContainer) {
                const logEntry = document.createElement('div');
                logEntry.className = 'log-entry error';
                logEntry.textContent = `[${new Date().toLocaleTimeString()}] ❌ ${this.app.t('errors.streamDisconnected')}`;
                logsContainer.appendChild(logEntry);
                logsContainer.scrollTop = logsContainer.scrollHeight;
            }
            try { eventSource.close(); } catch (_) {}

            if (!waitForTerminal) return;
            const terminalJob = await this.pollIntegratedJobUntilTerminal(jobId);
            finish(terminalJob);
        };

        return terminalPromise;
    }

    // Falls back to the job endpoint if the SSE connection drops while a queued list is running.
    async pollIntegratedJobUntilTerminal(jobId) {
        for (;;) {
            try {
                const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
                if (response.ok) {
                    const job = await response.json();
                    const terminal = String(job?.phase || job?.status || '').toLowerCase();
                    if (terminal === 'completed' || terminal === 'error' || terminal === 'canceled') {
                        return job;
                    }
                }
            } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 1200));
        }
    }

    // Updates Spotify metadata preview list for Spotify mapping and metadata flow.
    updateSpotifyPreviewList(entries) {
        const listContainer = document.getElementById('spotifyPreviewList');
        listContainer.innerHTML = '';

        entries.forEach((item, index) => {
            const matched = !!item.id;

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

        // The server is authoritative for the matched count. During async
        // mapping the DOM can lag behind the backend, so counting rendered
        // rows here can make the UI jump backwards (for example 200 -> 190).
    }

    // Converts matched Spotify metadata for Spotify mapping and metadata flow.
    async convertMatchedSpotify() {
    if (!this.currentSpotifyTask.id) {
        this.app.showNotification(this.app.t('notif.spotifyMappingFirst'), 'error', 'error');
        return;
    }

    try {
        const outputSettings = this.app.resolveCurrentOutputSettings();
        const format = outputSettings.format;
        const bitrate = outputSettings.bitrate;
        const sampleRate = outputSettings.sampleRate;
        const includeLyrics = document.getElementById('lyricsCheckbox').checked;
        const embedLyrics = !!document.getElementById('embedLyricsCheckbox')?.checked;
        const videoSettings = this.app.videoManager?.getSettings() || {};
        const audioProcessing = this.app.getCurrentAudioProcessingSettings();
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

        const spotifyConcurrency = this.getSpotifyConcurrency();

        const autoCreateZip = !isVideoFormat && this.app.autoCreateZip;

        const payload = {
            url: document.getElementById('urlInput').value.trim(),
            format,
            bitrate,
            sampleRate: sampleRate,
            includeLyrics,
            embedLyrics,
            isPlaylist: true,
            ...audioProcessing,
            autoCreateZip,
            ringtone: outputSettings.ringtone,
            ...(compressionLevel !== undefined ? { compressionLevel } : {}),
            ...(isVideoFormat ? { videoSettings } : {}),
            spotifyConcurrency,
            selectedIndices: validItems.map(item => item.index),
            spotifyMapId: this.currentSpotifyTask.id,
            metadata: {
                source: this.currentSpotifyTask.source || "spotify",
                spotifyTitle: document.getElementById('spotifyTitle').textContent,
                spotifyConcurrency,
                selectedIds: validItems.map(item => item.id),
                frozenEntries: validItems,
                spotifyMapId: this.currentSpotifyTask.id,
                includeLyrics,
                embedLyrics,
                ...audioProcessing
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

    // Returns current Spotify metadata matched items used for Spotify mapping and metadata flow.
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

    // Returns valid Spotify metadata items used for Spotify mapping and metadata flow.
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

    // Handles submit Spotify metadata job state in Spotify mapping and metadata flow.
    async submitSpotifyJob(payload) {
        try {
            this.app.applyCurrentOutputProfile(payload, { isFormData: false });
            this.app.applyCurrentAudioProcessingSettings(payload, { isFormData: false });
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
