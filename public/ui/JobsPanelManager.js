export class JobsPanelManager {
    constructor() {
        this.tokenKey = "gharmonize_admin_token";
        this.panel = null;
        this.overlay = null;
        this.list = null;
        this.state = { items: [] };
        this.filter = 'active';
        this.eventSource = null;
        this.isStarted = false;
        this.pollingInterval = null;
    }

    initialize() {
        if (this.isStarted) return;

        this.panel = document.getElementById('jobsPanel');
        this.overlay = document.getElementById('jobsOverlay');
        this.list = document.getElementById('jobsList');

        this.setupEventListeners();
        this.isStarted = true;

        if (localStorage.getItem(this.tokenKey)) {
            this.goOnline();
        } else {
            this.goOffline();
        }
    }

    setupEventListeners() {
        document.getElementById('jobsBell')?.addEventListener('click', () => this.open());
        this.overlay?.addEventListener('click', () => this.close());
        document.getElementById('jobsClose')?.addEventListener('click', () => this.close());
        document.getElementById('jobsFilterActive')?.addEventListener('click', () => this.setFilter('active'));
        document.getElementById('jobsFilterAll')?.addEventListener('click', () => this.setFilter('all'));

        window.addEventListener('gharmonize:auth', (ev) => {
            if (ev?.detail?.loggedIn) this.goOnline();
            else this.goOffline();
        });

        window.addEventListener('storage', (ev) => {
            if (ev.key !== this.tokenKey) return;
            if (ev.newValue) this.goOnline();
            else this.goOffline();
        });
    }

    open() {
        this.panel?.setAttribute('aria-hidden', 'false');
        this.overlay && (this.overlay.hidden = false);
    }

    close() {
        this.panel?.setAttribute('aria-hidden', 'true');
        this.overlay && (this.overlay.hidden = true);
    }

    setFilter(newFilter) {
        this.filter = newFilter;
        document.getElementById('jobsFilterActive')?.classList.toggle('chip--active', newFilter === 'active');
        document.getElementById('jobsFilterAll')?.classList.toggle('chip--active', newFilter === 'all');
        this.render();
    }

    goOnline() {
        document.getElementById('jobsBell').hidden = false;
        this.startSSE();
    }

    goOffline() {
        document.getElementById('jobsBell').hidden = true;
        this.close();
        this.eventSource?.close();
        this.eventSource = null;
        this.state = { items: [] };
        this.render();

        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    startSSE() {
        try {
            const token = localStorage.getItem(this.tokenKey) || "";
            this.eventSource = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

            this.eventSource.onmessage = (ev) => {
                try {
                    this.state = JSON.parse(ev.data) || { items: [] };
                    this.render();
                } catch (e) {
                    console.error('SSE parse error:', e);
                }
            };

            this.eventSource.onerror = () => {
                this.eventSource?.close();
                this.startPolling();
            };
        } catch (e) {
            console.error('SSE connection error:', e);
            this.startPolling();
        }
    }

    startPolling() {
        const poll = () => {
            const token = localStorage.getItem(this.tokenKey) || "";
            if (!token) {
                if (this.pollingInterval) {
                    clearInterval(this.pollingInterval);
                    this.pollingInterval = null;
                }
                return;
            }

            fetch(`/api/jobs?status=all`, {
                headers: { 'Authorization': 'Bearer ' + token }
            })
            .then(r => {
                if (r.status === 401) {
                    if (this.pollingInterval) {
                        clearInterval(this.pollingInterval);
                        this.pollingInterval = null;
                    }
                    return;
                }
                if (!r.ok) throw new Error('Failed to fetch jobs');
                return r.json();
            })
            .then(d => {
                if (d) {
                    this.state = { items: d.items || [] };
                    this.render();
                }
            })
            .catch(e => {
                console.error('Polling error:', e);
            });
        };

        poll();
        this.pollingInterval = setInterval(poll, 1500);
    }

    norm(s) {
        const v = String(s || '').toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
    }

    titleOf(j) {
        const m = j.metadata || {};
        const ex = m.extracted || {};
        return m.frozenTitle || m.spotifyTitle || ex.title || m.originalName ||
               (m.isAutomix ? this.t('jobsPanel.automix') : (m.isPlaylist ? this.t('jobsPanel.playlist') : this.t('jobsPanel.job')));
    }

    sourcePill(j) {
        const s = j.metadata?.source || 'file';
        const sources = {
            youtube: this.t('jobsPanel.sourceYouTube'),
            spotify: this.t('jobsPanel.sourceSpotify'),
            direct_url: this.t('jobsPanel.sourceURL'),
            file: this.t('jobsPanel.sourceFile')
        };
        return sources[s] || s;
    }

    phasePill(j) {
        const p = this.norm(j.currentPhase || j.status);
        const map = {
            preparing: this.t('phase.preparing'),
            downloading: this.t('phase.downloading'),
            converting: this.t('phase.converting'),
            completed: this.t('phase.completed'),
            error: this.t('phase.error'),
            canceled: this.t('status.canceled'),
            cancelled: this.t('status.canceled')
        };
        return map[p] || (j.currentPhase || j.status);
    }

    statusDot(j) {
        const s = this.norm(j.status);
        if (s === 'error') return '<span class="dot status-err">●</span>';
        if (s === 'completed') return '<span class="dot status-ok">●</span>';
        if (s === 'canceled') return '<span class="dot status-warn">●</span>';
        return '<span class="dot status-warn">●</span>';
    }

    prog(j) {
        if (typeof j.progress === 'number') return j.progress;
        const d = j.downloadProgress || 0, c = j.convertProgress || 0;
        return Math.floor((d + c) / 2);
    }

    currentIndex(j) {
        const total = j.playlist?.total;
        const done = j.playlist?.done;
        if (Number.isFinite(total) && Number.isFinite(done) && total > 0) {
            const idx0 = Math.min(Math.max(0, done || 0), Math.max(0, total - 1));
            return idx0;
        }
        return null;
    }

    nowTitle(j) {
        if (j.metadata?.isPlaylist && Array.isArray(j.metadata?.frozenEntries) && j.metadata.frozenEntries.length) {
            const i0 = this.currentIndex(j);
            if (i0 !== null && j.metadata.frozenEntries[i0]) {
                return `${j.metadata.frozenEntries[i0].index}. ${j.metadata.frozenEntries[i0].title}`;
            }
        }
        const ex = j.metadata?.extracted || {};
        return ex.track || ex.title || j.metadata?.originalName || null;
    }

    computeSkippedPanel(j) {
        const direct = Number(j?.skippedCount ?? j?.metadata?.skippedCount ?? 0);
        if (direct > 0) return direct;

        if (Number.isFinite(j?.playlist?.skipped))
            return Number(j.playlist.skipped);

        if (j?.metadata?.isPlaylist && Array.isArray(j?.resultPath)) {
            const successful = j.resultPath.filter(r => r && r.outputPath && !r.error).length;
            const total = Number(j?.playlist?.total ?? j?.metadata?.frozenEntries?.length ?? successful);
            return Math.max(0, total - successful);
        }
        return 0;
    }

    render() {
        const allItems = this.state.items.slice();
        const items = (this.filter === 'active')
            ? allItems.filter(j => !['completed', 'error', 'canceled'].includes(this.norm(j.status)))
            : allItems;

        const activeCount = allItems.filter(j => !['completed', 'error', 'canceled'].includes(this.norm(j.status))).length;
        const badge = document.getElementById('jobsBadge');
        if (badge) {
            badge.textContent = String(activeCount);
            badge.hidden = activeCount <= 0;
        }

        if (items.length === 0) {
            const isActive = (this.filter === 'active');
            this.list.innerHTML = `
                <div class="jobs-panel__empty">
                    <div class="jobs-panel__empty-icon">🎵</div>
                    <div class="jobs-panel__empty-title">
                        ${isActive ? this.t('jobsPanel.emptyActive') : this.t('jobs.empty')}
                    </div>
                    <div class="jobs-panel__empty-subtitle">
                        ${isActive ? this.t('jobsPanel.emptyDescriptionActive') : this.t('jobsPanel.emptyDescriptionAll')}
                    </div>
                    <div class="jobs-panel__empty-actions">
                        <button class="jobs-panel__empty-action" onclick="focusUrlInputAndClose()">
                            ${this.t('jobsPanel.addUrl')}
                        </button>
                        <button class="jobs-panel__empty-action jobs-panel__empty-action--outline" onclick="focusFileInputAndClose()">
                            ${this.t('section.file')}
                        </button>
                    </div>
                </div>
            `;
            if (window.i18n?.apply) window.i18n.apply(this.list);
            return;
        }

                const jobsHtml = items.map(j => {
            const p = this.prog(j);
            let downloadLinks = '';

            if (j.status === 'completed') {
                if (typeof j.resultPath === 'string' && j.resultPath) {
                    downloadLinks = `<a class="link" href="${j.resultPath}" download>${this.t('jobsPanel.downloadFile')}</a>`;
                } else if (Array.isArray(j.resultPath)) {
                    const successfulResults = j.resultPath.filter(r => r.outputPath && !r.error);
                    if (successfulResults.length > 0) {
                        if (j.zipPath) {
                            downloadLinks = `<a class="link" href="${j.zipPath}" download>${this.t('jobsPanel.downloadZip')}</a>`;
                        } else {
                            downloadLinks = `<span class="link" style="opacity:.8" title="${this.t('jobsPanel.multipleOutputs')}">${this.t('jobsPanel.multiple')}</span>`;
                        }
                    }
                } else if (typeof j.resultPath === 'object' && j.resultPath?.outputPath) {
                    downloadLinks = `<a class="link" href="${j.resultPath.outputPath}" download>${this.t('jobsPanel.downloadFile')}</a>`;
                }
            }

            const baseTitle = this.titleOf(j);
            const nowT = this.nowTitle(j);
            const titleText = (j.metadata?.isPlaylist && nowT)
                ? `${baseTitle} — ${nowT}`
                : (nowT || baseTitle);

            const skippedCount = this.computeSkippedPanel(j);
            const skippedKeywords = /(private|izin|skipp?ed|unavailable|atlan(?:d|an)|blocked|copyright|region|geo)/i;
            const showSkippedBadge =
                (skippedCount > 0) ||
                (j.lastLog && skippedKeywords.test(String(j.lastLog))) ||
                (j.lastLogKey && skippedKeywords.test(String(j.lastLogKey))) ||
                (j.error && skippedKeywords.test(String(j.error?.message || j.error)));

            const skippedBadge = showSkippedBadge
                ? `<span class="chip chip--warn" title="atlananlar">⚠️ ${this.t('jobs.skipped')}${skippedCount ? ` (${skippedCount})` : ''}</span>`
                : '';

            const cancelInfo = (j.canceledBy === 'user')
                ? `<div class="muted" style="font-size:12px;margin-top:4px;">
                        ${this.t('status.canceled')}
                   </div>`
                : '';

            return `
                <div class="job-card" data-job-id="${j.id}">
                    <div class="job-title">${this.statusDot(j)}<span>${titleText}</span></div>

                    <div class="job-meta">
                        <span class="pill">${this.sourcePill(j)}</span>
                        <span class="pill">${(j.format || '').toUpperCase()} ${j.bitrate || ''}</span>
                        ${j.sampleRate ? `<span class="pill">${Math.round(j.sampleRate / 1000)} kHz</span>` : ''}
                        <span class="pill">${this.phasePill(j)}</span>
                        ${skippedBadge}
                    </div>

                    ${(() => {
                        const nt = nowT;
                        return nt ? `<div class="muted" style="font-size:12px">▶️ <strong>${nt}</strong></div>` : '';
                    })()}

                    ${cancelInfo}

                    <div class="progress panel" role="progressbar"
                         aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}">
                        <span style="width:${p}%"></span>
                    </div>

                    <div class="row panel">
                        <span>${p}%</span>
                        <span style="display:flex; gap:8px; align-items:center;">
                            ${downloadLinks}
                            <button class="btn-danger" data-stop-panel="${j.id}" ${(['completed', 'error', 'canceled'].includes(this.norm(j.status))) ? 'disabled' : ''} title="${this.t('btn.stop')}">${this.t('btn.stop')}</button>
                        </span>
                    </div>
                </div>
            `;
        }).join('');

        if (this.filter === 'active') {
            const activeTitleKey = 'jobsPanel.activeGroupTitle';
                const activeTitle = this.t(activeTitleKey);

                this.list.innerHTML = `
                    <section class="collapsible-section">
                        <button
                            type="button"
                            class="collapsible-section__header"
                            aria-expanded="true"
                        >
                            <span class="collapsible-section__title" data-i18n="${activeTitleKey}">
                                ${activeTitle}
                            </span>
                            <span class="collapsible-section__badge">${items.length}</span>
                            <span class="collapsible-section__icon" aria-hidden="true">▾</span>
                        </button>
                        <div class="collapsible-section__body">
                            ${jobsHtml}
                        </div>
                    </section>
                `;
        } else {
            this.list.innerHTML = jobsHtml;
        }

        if (window.i18n?.apply) window.i18n.apply(this.list);
        if (this.filter === 'active') {
            const header = this.list.querySelector('.collapsible-section__header');
            const body   = this.list.querySelector('.collapsible-section__body');
            if (header && body) {
                header.addEventListener('click', () => {
                    const expanded = header.getAttribute('aria-expanded') === 'true';
                    header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                    body.hidden = expanded;
                    header.classList.toggle('is-collapsed', expanded);
                });
            }
        }

        this.list.querySelectorAll('[data-stop-panel]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.getAttribute('data-stop-panel');
                btn.disabled = true;
                const j = this.state.items.find(x => x.id === id);
                const cb = j?.clientBatch || null;

                if (cb) {
                    const sameBatch = this.state.items.filter(x => x.clientBatch === cb);
                    try {
                        await Promise.allSettled(sameBatch.map(x =>
                            fetch(`/api/jobs/${encodeURIComponent(x.id)}/cancel`, { method: 'POST' })
                        ));
                        this.state.items = this.state.items.map(x =>
                            x.clientBatch === cb ? { ...x, status: 'canceled', phase: 'canceled' } : x
                        );
                        this.render();
                        return;
                    } catch (_) { }
                }

                try {
                    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
                    if (!r.ok) {
                        const e = await r.json().catch(() => ({}));
                        throw new Error(e?.error?.message || this.t('notif.cancelFailed'));
                    }
                    const idx = this.state.items.findIndex(j => j.id === id);
                    if (idx >= 0) {
                        this.state.items[idx] = { ...this.state.items[idx], status: 'canceled', phase: 'canceled' };
                        this.render();
                    }
                } catch (e) {
                    btn.disabled = false;
                }
            };
        });
    }

    t(key, vars) {
        return (window.i18n?.t?.(key, vars)) ?? key;
    }
}

export class JobManager {
    constructor(app) {
        this.app = app;
        this.currentJobs = new Map();
        this.jobStates = new Map();
        this.batches = new Map();
        this.jobToBatch = new Map();
        this.sessionSectionsInitialized = false;
    }

    trackJob(jobId, batchId = null) {
        if (this.currentJobs.has(jobId)) return;
        const eventSource = new EventSource(`/api/stream/${jobId}`);
        let firstUpdate = true;

        eventSource.onmessage = (event) => {
            const job = JSON.parse(event.data);
            job.status = this.normalizeStatus(job.status);
            job.currentPhase = this.normalizeStatus(job.currentPhase);
            job.phase = this.normalizeStatus(job.phase);
            this.jobStates.set(jobId, job);

            if (firstUpdate) {
                firstUpdate = false;
                document.dispatchEvent(new CustomEvent('job:first-update', { detail: { jobId, job } }));
            }

            this.updateJobUI(job, batchId);
            if (job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
                eventSource.close();
                this.currentJobs.delete(jobId);
            }
        };

        eventSource.onerror = (error) => {
            console.error('SSE error:', error);
            eventSource.close();
            this.currentJobs.delete(jobId);
        };

        this.currentJobs.set(jobId, eventSource);
    }

    normalizeStatus(s) {
        const v = String(s || '').toLowerCase();
        return v === 'cancelled' ? 'canceled' : v;
    }

    computeSkipped(job) {
        const fromStats = Number(job?.metadata?.skipStats?.skippedCount);
        if (Number.isFinite(fromStats) && fromStats >= 0) return fromStats;
        const direct = Number(job?.skippedCount ?? job?.metadata?.skippedCount);
        if (Number.isFinite(direct) && direct >= 0) return direct;

        if (Number.isFinite(job?.playlist?.skipped)) {
            return Number(job.playlist.skipped);
        }

        if (Number.isFinite(job?.errorsCount)) {
            return Number(job.errorsCount);
        }

        if (job?.metadata?.isPlaylist && Array.isArray(job?.resultPath)) {
            const successful = job.resultPath.filter(r => r && r.outputPath && !r.error).length;
            const total = Number(job?.playlist?.total ?? job?.metadata?.frozenEntries?.length ?? successful);
            return Math.max(0, Math.min(total, total - successful));
        }

        if (job?.stderr) {
            const skipPattern = /(private|izin|skipp?ed|unavailable|atlan(?:d|an)|blocked|copyright|region|geo)/gi;
            const matches = job.stderr.match(skipPattern);
            return matches ? matches.length : 0;
        }

        return 0;
    }

    uiCurrentIndex(job) {
        const total = job.playlist?.total;
        const done = job.playlist?.done;
        const current = job.playlist?.current || done;
        if (Number.isFinite(total) && Number.isFinite(done) && total > 0) {
            return Math.min(Math.max(0, done || 0), Math.max(0, total - 1));
        }
        return null;
    }

    uiNowTitle(job) {
        if (job.metadata?.isPlaylist && Array.isArray(job.metadata?.frozenEntries) && job.metadata.frozenEntries.length) {
            const i0 = job.playlist?.current || this.uiCurrentIndex(job);
            if (i0 !== null && job.metadata.frozenEntries[i0]) {
                const e = job.metadata.frozenEntries[i0];
                return `${e.index}. ${e.title}`;
            }
        }
        const ex = job.metadata?.extracted || {};
        return ex.track || ex.title || job.metadata?.originalName || null;
    }

    updateJobUI(job, batchId = null) {
        const statusNorm = this.normalizeStatus(job.status);
        const batchKey = batchId || job.clientBatch;
        const listRoot = document.getElementById('jobList');
        if (!listRoot) return;

        if (!this.sessionSectionsInitialized) {
            const empty = document.getElementById('job-empty');
            if (empty) empty.remove();

            const activeTitleKey = 'jobsPanel.activeGroupTitle';
            const completedTitleKey = 'jobsPanel.completedGroupTitle';

            const activeTitle = this.app.t(activeTitleKey);
            const completedTitle = this.app.t(completedTitleKey);

            listRoot.innerHTML = `
                <section class="collapsible-section" data-section="active-session">
                    <button
                        type="button"
                        class="collapsible-section__header"
                        aria-expanded="true"
                    >
                        <span class="collapsible-section__title" data-i18n="${activeTitleKey}">
                            ${activeTitle}
                        </span>
                        <span class="collapsible-section__badge" id="session-active-count">0</span>
                        <span class="collapsible-section__icon" aria-hidden="true">▾</span>
                    </button>
                    <div class="collapsible-section__body" id="session-active-body"></div>
                </section>

                <section class="collapsible-section" data-section="completed-session">
                    <button
                        type="button"
                        class="collapsible-section__header"
                        aria-expanded="false"
                    >
                        <span class="collapsible-section__title" data-i18n="${completedTitleKey}">
                            ${completedTitle}
                        </span>
                        <span class="collapsible-section__badge" id="session-completed-count">0</span>
                        <span class="collapsible-section__icon" aria-hidden="true">▾</span>
                    </button>
                    <div class="collapsible-section__body" id="session-completed-body" hidden></div>
                </section>
            `;

            if (window.i18n?.apply) window.i18n.apply(listRoot);

            listRoot.querySelectorAll('.collapsible-section__header').forEach(header => {
                const body = header.parentElement.querySelector('.collapsible-section__body');
                if (!body) return;
                header.addEventListener('click', () => {
                    const expanded = header.getAttribute('aria-expanded') === 'true';
                    header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                    body.hidden = expanded;
                    header.classList.toggle('is-collapsed', expanded);
                });
            });

            this.sessionSectionsInitialized = true;
        }

        const activeBody = document.getElementById('session-active-body');
        const completedBody = document.getElementById('session-completed-body');
        if (batchKey) {
            const batch = this.batches.get(batchKey);
            if (batch) {
                batch.jobs.add(job.id);
                this.jobStates.set(job.id, job);
                this.jobToBatch.set(job.id, batchKey);

                if (statusNorm === 'completed' && job.resultPath && !Array.isArray(job.resultPath)) {
                    const nowTrackTitle = this.uiNowTitle(job);

                    const selIdx = Array.isArray(job.metadata?.selectedIndices)
                        ? Number(job.metadata.selectedIndices[0])
                        : null;

                    let entryBySel = null;
                    if (Number.isFinite(selIdx) && Array.isArray(job.metadata?.frozenEntries)) {
                        entryBySel =
                            job.metadata.frozenEntries.find(e => e.index === selIdx) ||
                            job.metadata.frozenEntries[selIdx - 1] ||
                            null;
                    }

                    const entry0 = Array.isArray(job.metadata?.frozenEntries) && job.metadata.frozenEntries.length
                        ? job.metadata.frozenEntries[0]
                        : null;

                    let resolvedTitle =
                        nowTrackTitle ||
                        job.metadata?.extracted?.track ||
                        job.metadata?.extracted?.title ||
                        entryBySel?.title ||
                        entry0?.title ||
                        job.metadata?.originalName ||
                        (Number.isFinite(selIdx) &&
                         this.app.previewManager?.currentPreview?.indexToTitle?.get(selIdx)) ||
                        this.app.t('ui.track');

                    let hrefRaw;
                    if (typeof job.resultPath === 'string') {
                        hrefRaw = job.resultPath;
                    } else if (job.resultPath && typeof job.resultPath === 'object') {
                        hrefRaw = job.resultPath.outputPath || job.resultPath.path || '';
                    } else {
                        hrefRaw = '';
                    }

                    if (hrefRaw) {
                        this.appendBatchRow(batchKey, {
                            title: resolvedTitle,
                            href: hrefRaw
                        });
                    }
                }

                this.updateBatchProgress(batchKey);

                const allJobs = Array.from(batch.jobs);
                const completedJobs = allJobs.filter(jobId => {
                    const j = this.jobStates.get(jobId);
                    return j && this.normalizeStatus(j.status) === 'completed';
                }).length;

                if (completedJobs >= batch.total && !batch.el.querySelector('.zip-all')) {
                    const lastCompletedJob = allJobs
                        .map(id => this.jobStates.get(id))
                        .find(j => j && this.normalizeStatus(j.status) === 'completed' && j.zipPath);

                    if (lastCompletedJob && lastCompletedJob.zipPath) {
                        const zipBtn = document.createElement('div');
                        zipBtn.className = 'download-item zip-all';
                        zipBtn.innerHTML = `
                            <strong>${this.app.t('ui.all')}:</strong>
                            <a href="${this.app.toRelative(lastCompletedJob.zipPath)}" class="download-btn" download>
                                ${this.app.t('download.allZip')}
                            </a>
                        `;
                        batch.el.querySelector('.download-list').appendChild(zipBtn);
                    }
                }
            }
        }

        let phaseInfo = '';
        if (job.metadata?.source === 'spotify' && job.phase) {
            const phaseText = {
                mapping: this.app.t('phase.mapping'),
                downloading: this.app.t('phase.downloading'),
                converting: this.app.t('phase.converting'),
                completed: this.app.t('phase.completed')
            };
            phaseInfo = ` • ${phaseText[job.phase] || job.phase}`;
        }

        let phaseDetails = '';
        if (job.currentPhase) {
            const phaseTexts = {
                preparing: this.app.t('phase.preparing'),
                downloading: this.app.t('phase.downloading'),
                converting: this.app.t('phase.converting'),
                completed: this.app.t('phase.completed'),
                canceled: this.app.t('status.canceled'),
                cancelled: this.app.t('status.canceled'),
                error: this.app.t('phase.error')
            };

            const currentPhaseText = phaseTexts[job.currentPhase] || job.currentPhase;

            if (job.playlist && job.playlist.total) {
                if (job.metadata?.source === 'spotify') {
                    let downloaded, converted;

                    if (job.currentPhase === 'downloading') {
                        downloaded = job.playlist.done || 0;
                        converted = 0;
                    } else if (job.currentPhase === 'converting') {
                        downloaded = job.playlist.total;
                        converted = job.playlist.done || 0;
                    } else {
                        downloaded = job.playlist.done || 0;
                        converted = job.playlist.done || 0;
                    }

                    phaseDetails = `
                        <div class="phase-details">
                            <div class="phase-details__title">${currentPhaseText}</div>
                            <div class="phase-details__grid">
                                <span class="phase-details__item">
                                    🎵 ${this.app.t('ui.current')}:
                                    <span class="phase-details__value">${(job.playlist.current || job.playlist.done || 0) + 1}</span>
                                </span>
                                <span class="phase-details__item">
                                    📥 ${this.app.t('ui.downloading')}:
                                    <span class="phase-details__value">${downloaded}/${job.playlist.total}</span>
                                </span>
                                <span class="phase-details__item">
                                    ⚡ ${this.app.t('ui.converting')}:
                                    <span class="phase-details__value">${converted}/${job.playlist.total}</span>
                                </span>
                            </div>
                        </div>
                    `;
                } else {
                    const total = Number(job.playlist.total || 0) || 0;
                    let downloaded = Number(job.counters?.dlDone ?? job.playlist.done ?? 0) || 0;
                    let converted  = Number(job.counters?.cvDone ?? job.playlist.done ?? 0) || 0;

                    if (!downloaded && total && job.downloadProgress) {
                        downloaded = Math.max(
                            0,
                            Math.min(total, Math.floor((job.downloadProgress / 100) * total))
                        );
                    }
                    if (!converted && total && job.convertProgress) {
                        converted = Math.max(
                            0,
                            Math.min(total, Math.floor((job.convertProgress / 100) * total))
                        );
                    }

                    const phase = this.normalizeStatus(job.currentPhase || job.phase);

                    let currentTrack;
                    if (Number.isFinite(job.playlist.current)) {
                        currentTrack = job.playlist.current + 1;
                    } else if (phase === 'downloading') {
                        currentTrack = Math.min(total || 1, (downloaded || 0) + 1);
                    } else if (phase === 'converting') {
                        currentTrack = Math.min(total || 1, (converted || 0) + 1);
                    } else {
                        const base = converted || downloaded || 0;
                        currentTrack = Math.min(total || 1, Math.max(1, base || 1));
                    }

                    phaseDetails = `
                        <div class="phase-details">
                            <div class="phase-details__title">${currentPhaseText}</div>
                            <div class="phase-details__grid">
                                <span class="phase-details__item">
                                    🎵 ${this.app.t('ui.current')}:
                                    <span class="phase-details__value">${currentTrack}</span>
                                </span>
                                <span class="phase-details__item">
                                    📥 ${this.app.t('ui.downloading')}:
                                    <span class="phase-details__value">${downloaded}/${total || '?'}</span>
                                </span>
                                <span class="phase-details__item">
                                    ⚡ ${this.app.t('ui.converting')}:
                                    <span class="phase-details__value">${converted}/${total || '?'}</span>
                                </span>
                            </div>
                        </div>
                    `;
                }
            } else if (job.metadata?.isPlaylist) {
                const dlDone = Number(job?.counters?.dlDone || 0);
                const cvDone = Number(job?.counters?.cvDone || 0);
                const total  = Number(
                    (job?.playlist && job.playlist.total) ||
                    (job?.counters && job.counters.dlTotal) || 0
                );
                const totalTxt = total > 0 ? total : '?';
                const curIdx = (job.playlist && Number.isFinite(job.playlist.current))
                    ? (job.playlist.current + 1)
                    : (dlDone + 1);
                phaseDetails = `
                    <div class="phase-details">
                        <div class="phase-details__title">${currentPhaseText}</div>
                        <div class="phase-details__grid">
                            <span class="phase-details__item">
                                🎵 ${this.app.t('ui.current')}:
                                <span class="phase-details__value">${curIdx}</span>
                            </span>
                            <span class="phase-details__item">
                                📥 ${this.app.t('ui.downloading')}:
                                <span class="phase-details__value">${dlDone}/${totalTxt}</span>
                            </span>
                            <span class="phase-details__item">
                                ⚡ ${this.app.t('ui.converting')}:
                                <span class="phase-details__value">${cvDone}/${totalTxt}</span>
                            </span>
                        </div>
                    </div>
                `;
            } else {
                phaseDetails = `
                    <div class="phase-details" style="margin-top: 8px;">
                        <div class="phase-details__title" style="margin-bottom: 6px;">${currentPhaseText}</div>
                            <div class="phase-details__grid">
                                <span class="phase-details__item">
                                    📥 ${this.app.t('ui.downloading')}:
                                    <span class="phase-details__value">${Math.floor(job.downloadProgress || 0)}%</span>
                                </span>
                                    <span class="phase-details__item">
                                    ⚡ ${this.app.t('ui.converting')}:
                                    <span class="phase-details__value">${Math.floor(job.convertProgress || 0)}%</span>
                                </span>
                            </div>
                        </div>
                    </div>
                `;
            }
        }

        let jobElement = document.getElementById(`job-${job.id}`);
        const statusText = {
            queued: this.app.t('status.queued'),
            running: this.app.t('status.running'),
            completed: this.app.t('status.completed'),
            error: this.app.t('status.error'),
            canceled: this.app.t('status.canceled'),
            cancelled: this.app.t('status.canceled')
        };

        const exMeta  = job.metadata?.extracted || {};
        const entry0  = Array.isArray(job.metadata?.frozenEntries) && job.metadata.frozenEntries.length
            ? job.metadata.frozenEntries[0]
            : null;
        const trackLabel = exMeta.track || exMeta.title || entry0?.title || null;

        let jobTitle = trackLabel || job.metadata?.originalName || job.metadata?.source || '';

        if (job.metadata?.source === 'spotify') {
            jobTitle = `🎵 ${job.metadata.spotifyTitle || this.app.t('ui.spotifyPlaylist')}`;
        }
        {
            const nowTrack = this.uiNowTitle(job);
            if (job.metadata?.isPlaylist && nowTrack) {
                const listName =
                    job.metadata?.frozenTitle
                    || (job.metadata?.source === 'spotify'
                        ? (job.metadata?.spotifyTitle || this.app.t('ui.spotifyPlaylist'))
                        : this.app.t('ui.youtubePlaylist'));
                jobTitle = `${this.app.escapeHtml(listName)} — ${this.app.escapeHtml(nowTrack)}`;
            }
        }

        const skippedCount = this.computeSkipped(job);
        const skippedKeywords = /(private|izin|skipp?ed|unavailable|atlan(?:d|an)|blocked|copyright|region|geo)/i;
        const showSkippedBadge =
            (skippedCount > 0) ||
            (job.lastLog && skippedKeywords.test(String(job.lastLog))) ||
            (job.lastLogKey && skippedKeywords.test(String(job.lastLogKey))) ||
            (job.error && skippedKeywords.test(String(job.error?.message || job.error)));

        const skippedBadge = showSkippedBadge
            ? `<span class="chip chip--warn" title="${this.app.escapeHtml(job.lastLog || 'atlananlar')}">⚠️ ${this.app.t('jobs.skipped')}${skippedCount ? ` (${skippedCount})` : ''}</span>`
            : '';

        let resultContent = '';

        if (job.status === 'completed') {
            if (Array.isArray(job.resultPath)) {
                const successfulResults = job.resultPath.filter(r => r.outputPath && !r.error);
                if (successfulResults.length > 0) {
                    const hasLyrics = job.metadata.includeLyrics;
                    resultContent = `
                        <div class="download-list">
                            ${successfulResults.map((r, i) => {
                                const trackTitle = job.metadata?.frozenEntries?.[i]?.title || this.app.t('ui.track', { number: i + 1 });
                                const lrcBtn = r.lyricsPath
                                    ? `<a href="${this.app.toRelative(r.lyricsPath)}" class="download-btn" download>${this.app.t('download.lyrics')}</a>`
                                    : '';
                                return `
                                    <div class="download-item">
                                        <span>${i + 1}. ${this.app.escapeHtml(trackTitle)}</span>
                                        <a href="${this.app.toRelative(r.outputPath)}" class="download-btn" download>${this.app.t('download.single')}</a>
                                        ${lrcBtn}
                                    </div>
                                `;
                            }).join('')}
                            ${job.zipPath ? `
                                <div class="download-item" style="margin-top:8px;">
                                    <strong>${this.app.t('ui.all')}:</strong>
                                    <a href="${this.app.toRelative(job.zipPath)}" class="download-btn" download>
                                        ${hasLyrics ? this.app.t('download.allWithLyrics') : this.app.t('download.all')}
                                    </a>
                                </div>` : ''}
                        </div>
                    `;
                } else {
                    resultContent = `<div style="color: var(--error); font-size: 13px;">❌ ${this.app.t('ui.noFilesConverted')}</div>`;
                }
            } else if (job.resultPath) {
                const rp = (typeof job.resultPath === 'string')
                    ? { outputPath: job.resultPath }
                    : job.resultPath;
                const hasLyricsFlag = !!rp.lyricsPath;
                const baseBtn = `<a href="${this.app.toRelative(rp.outputPath)}" class="download-btn" download>${this.app.t('download.single')}</a>`;
                const lrcBtn = hasLyricsFlag
                    ? `<a href="${this.app.toRelative(rp.lyricsPath)}" class="download-btn" download>${this.app.t('download.lyrics')}</a>`
                    : '';
                resultContent = `${baseBtn} ${lrcBtn}`;
            }
        }

        let totalProgress = Number(job.progress || 0);
        if (!Number.isFinite(totalProgress) || totalProgress <= 0) {
            const dl = Number(job.downloadProgress || 0);
            const cv = Number(job.convertProgress || 0);

            if (dl || cv) {
                totalProgress = Math.max(dl, cv);
            } else {
                totalProgress = 0;
            }
        }

        let lyricsInfo = '';

        if (job.metadata?.includeLyrics && job.metadata?.lyricsStats) {
            const stats = job.metadata.lyricsStats;
            lyricsInfo = `<div class="lyrics-stats" style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
                🎼 ${this.app.t('label.includeLyrics2')}: ${this.app.t('ui.found')} ${stats.found}, ${this.app.t('ui.notFound')} ${stats.notFound}
            </div>`;
        }

        let lastLogInfo = '';

        if (job.lastLog || job.lastLogKey) {
            const raw = job.lastLogKey ? this.app.t(job.lastLogKey, job.lastLogVars || {}) : this.app.normalizeLog(job.lastLog);
            lastLogInfo = `<div class="last-log" style="font-size: 12px; color: var(--text-muted); margin: 4px 0; font-style: italic;">
                ${this.app.escapeHtml(raw)}
            </div>`;
        }

        let cancelInfo = '';
        if (job.canceledBy === 'user') {
            const selIdx = Array.isArray(job.metadata?.selectedIndices)
                ? job.metadata.selectedIndices[0]
                : null;

            const textKey = Number.isFinite(selIdx)
                ? 'status.canceledIndexed'
                : 'status.canceled';

            const msg = this.app.t(textKey, Number.isFinite(selIdx) ? { index: selIdx } : undefined);

            cancelInfo = `<div style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
               ${this.app.escapeHtml(msg)}
           </div>`;
        }

        if (!jobElement) {
            jobElement = document.createElement('div');
            jobElement.id = `job-${job.id}`;
            jobElement.className = 'job-item';
        }

        jobElement.innerHTML = `
            <strong>${this.app.escapeHtml(jobTitle)}</strong>
            <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
                ${job.format.toUpperCase()} • ${job.bitrate}
                ${job.sampleRate ? ` • ${Math.round(job.sampleRate / 1000)} kHz` : ''}
                ${job.metadata?.isPlaylist ? ` • ${this.app.t('ui.playlist')}` : ''}
                ${job.metadata?.includeLyrics ? ` • 🎼 ${this.app.t('label.includeLyrics2')}` : ''}
                ${phaseInfo}
                ${skippedBadge}
            </div>

            ${lyricsInfo}
            ${lastLogInfo}
            ${cancelInfo}

            ${phaseDetails}

            ${(() => {
                const nt = this.uiNowTitle(job);
                return nt ? `<div class="muted" style="font-size:12px; margin: 8px 0 4px 0;">▶️ <strong>${this.app.escapeHtml(nt)}</strong></div>` : '';
            })()}

            <div class="progress-bar">
                <div class="progress-fill" style="width: ${totalProgress}%"></div>
            </div>
            <div class="job-actions" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px;">
                <span class="status status-${job.status}">${statusText[job.status]}</span>
                <div style="display:flex; gap:8px; align-items:center; flex-direction: column;">
                    ${resultContent}
                    <button class="btn-danger" data-stop="${job.id}" ${(['completed', 'error', 'canceled'].includes(statusNorm)) ? 'disabled' : ''} title="${this.app.t('btn.stop')}">${this.app.t('btn.stop')}</button>
                </div>
            </div>
            ${job.error ? `<div style="color: var(--error); font-size: 13px; margin-top: 8px; padding: 8px; background: var(--bg-card); border-radius: 6px;">${this.app.escapeHtml(job.error)}</div>` : ''}
        `;
        const parentForJob = (statusNorm === 'completed' || statusNorm === 'canceled')
            ? completedBody
            : activeBody;
        if (parentForJob && jobElement.parentElement !== parentForJob) {
            parentForJob.appendChild(jobElement);
        }
        this.jobStates.set(job.id, job);

        let activeCount = 0;
        let completedCount = 0;
        for (const j of this.jobStates.values()) {
            const s = this.normalizeStatus(j.status);
            if (s === 'completed' || s === 'canceled') {
                completedCount++;
            } else {
                activeCount++;
            }
        }
        const activeBadge = document.getElementById('session-active-count');
        const completedBadge = document.getElementById('session-completed-count');
        if (activeBadge) activeBadge.textContent = String(activeCount);
        if (completedBadge) completedBadge.textContent = String(completedCount);
        const stopBtn = jobElement.querySelector(`[data-stop="${job.id}"]`);
        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                stopBtn.disabled = true;

                try {
                    const r = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
                        method: 'POST'
                    });

                    if (!r.ok) {
                        const e = await r.json().catch(() => ({}));
                        throw new Error(e?.error?.message || this.app.t('notif.cancelFailed'));
                    }

                    const js = this.jobStates.get(job.id) || {};
                    js.status = 'canceled';
                    js.phase = 'canceled';
                    js.currentPhase = 'canceled';
                    this.jobStates.set(job.id, js);
                    this.updateJobUI(js, this.jobToBatch.get(job.id) || null);

                    this.app.showNotification(this.app.t('notif.canceledByUser'), 'success', 'action');
                } catch (e) {
                    stopBtn.disabled = false;
                    this.app.showNotification(`${this.app.t('notif.cancelFailed')}: ${e.message}`, 'error', 'error');
                }
            });
        }
    }

    ensureBatch(batchId, total, meta) {
        let batch = this.batches.get(batchId);

        if (batch) {
            if (Number.isFinite(total)) batch.total = total;
            return batch;
        }

        const jobList = document.getElementById('jobList');
        const empty = document.getElementById('job-empty');
        if (empty) empty.remove();

        const batchElement = document.createElement('div');
        batchElement.className = 'job-item';
        batchElement.id = `batch-${batchId}`;
        const sourceText = meta?.source || this.app.t('ui.playlist');
        const seqText = this.app.t('label.sequential');
        batchElement.innerHTML = `
            <strong>${sourceText} — ${this.app.t('label.sequential')}</strong>
            <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
                ${meta?.format?.toUpperCase() || ''} • ${meta?.bitrate || ''}
            </div>
            <div class="progress-bar">
                <div class="progress-fill" id="batch-progress-${batchId}" style="width: 0%"></div>
            </div>
            <div class="batch-info">
                ${this.app.t('batch.done')}: <span id="batch-done-${batchId}">0</span> / <span id="batch-total-${batchId}">${total || '?'}</span>
            </div>
            <div class="batch-actions" style="margin:8px 0 4px; display:flex; justify-content:flex-end;">
                <button class="btn-danger" data-stop-batch="${batchId}">
                    ${this.app.t('btn.stop') || 'Hepsini Durdur'}
                </button>
            </div>
            <div class="download-list" id="batch-list-${batchId}"></div>
        `;

        jobList.appendChild(batchElement);

        batch = {
            el: batchElement,
            total: total || 0,
            done: 0,
            jobs: new Set()
        };

        this.batches.set(batchId, batch);
        const stopBtn = batchElement.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.cancelBatch(batchId));
        }
        return batch;
    }

    appendBatchRow(batchId, { title, href }) {
        const list = document.getElementById(`batch-list-${batchId}`);
        if (!list) return;

        let raw = '';
            if (typeof href === 'string') {
                raw = href;
            } else if (href && typeof href === 'object') {
                raw = href.outputPath || href.path || '';
            }
            if (!raw) return;

    const finalHref = this.app.toRelative(raw);

        const row = document.createElement('div');
        row.className = 'download-item';
        row.innerHTML = `
            <span>${this.app.escapeHtml(title || this.app.t('ui.track'))}</span>
            <a href="${finalHref}" class="download-btn" download>${this.app.t('download.single')}</a>
        `;
        list.appendChild(row);
    }

    updateBatchProgress(batchId) {
        const batch = this.batches.get(batchId);
        if (!batch) return;

        const jobs = Array.from(batch.jobs)
            .map(id => this.jobStates.get(id))
            .filter(Boolean);

        const total = batch.total || jobs.length || 1;

        let totalProgressSum = 0;
        let completedCount = 0;

        for (const j of jobs) {
            const status = this.normalizeStatus(j.status);

            if (status === 'completed') {
                totalProgressSum += 100;
                completedCount++;
                continue;
            }

            const dl = Number(j.downloadProgress ?? j.progress ?? 0) || 0;
            const cv = Number(j.convertProgress ?? 0) || 0;

            let single;
            if (dl && cv) {
                single = dl * 0.5 + cv * 0.5;
            } else {
                single = dl || cv;
            }

            totalProgressSum += Math.max(0, Math.min(100, single));
        }

        const percentage = Math.min(100, Math.max(0, totalProgressSum / total));

        batch.done = completedCount;

        const progressElement = document.getElementById(`batch-progress-${batchId}`);
        const doneElement = document.getElementById(`batch-done-${batchId}`);
        const totalElement = document.getElementById(`batch-total-${batchId}`);

        if (progressElement) progressElement.style.width = `${percentage}%`;
        if (doneElement) doneElement.textContent = completedCount;
        if (totalElement) totalElement.textContent = total;

        const anyActive = jobs.some(j => {
            const s = this.normalizeStatus(j.status);
            return !['completed', 'error', 'canceled'].includes(s);
        });
        const stopBtn = document.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) stopBtn.disabled = !anyActive;
    }

    async cancelBatch(batchId) {
        const batch = this.batches.get(batchId);
        if (!batch) return;
        const ids = Array.from(batch.jobs || []);
        if (!ids.length) return;

        const stopBtn = document.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) stopBtn.disabled = true;

        const tasks = ids.map(async (id) => {
            const j = this.jobStates.get(id);
            const s = this.normalizeStatus(j?.status);
            if (!j || ['completed', 'error', 'canceled'].includes(s)) return;
            try {
                const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
                if (r.ok) {
                    const js = this.jobStates.get(id) || {};
                    js.status = 'canceled';
                    js.phase = 'canceled';
                    js.currentPhase = 'canceled';
                    this.jobStates.set(id, js);
                    this.updateJobUI(js, batchId);
                }
            } catch (_) { }
        });

        await Promise.allSettled(tasks);
        this.updateBatchProgress(batchId);
        this.app.showNotification(this.app.t('notif.canceledByUser') || 'Batch iptal edildi', 'success', 'action');
    }

    async submitJob(payload, isFormData = false) {
        try {
            console.log("Gönderilen payload:", payload);

            const format = document.getElementById('formatSelect').value;

            if (format === 'mp4' && this.app.videoManager.videoSettings.transcodeEnabled) {
                console.log("🎬 Video ayarları payload'a ekleniyor:", this.app.videoManager.videoSettings);
                if (!isFormData) {
                    payload.videoSettings = this.app.videoManager.videoSettings;
                } else {
                    payload.append('videoSettings', JSON.stringify(this.app.videoManager.videoSettings));
                }
            } else {
            }

            if (payload.selectedStreams && !isFormData) {
                payload.selectedStreams = JSON.stringify(payload.selectedStreams);
            } else if (payload.selectedStreams && isFormData) {
                payload.append('selectedStreams', JSON.stringify(payload.selectedStreams));
            }

            if (format === 'eac3' || format === 'ac3' || format === 'aac') {
                const stereoConvert = document.getElementById('stereoConvertSelect')?.value || 'auto';
                const atempoAdjust = document.getElementById('atempoSelect')?.value || 'none';

                if (!isFormData) {
                    payload.stereoConvert = stereoConvert;
                    payload.atempoAdjust = atempoAdjust;
                } else {
                    payload.append('stereoConvert', stereoConvert);
                    payload.append('atempoAdjust', atempoAdjust);
                }
            }

            if (format === 'flac' || format === 'wav') {
                const bitDepth = document.getElementById('bitDepthSelect')?.value || '16';
                if (!isFormData) {
                    payload.bitDepth = bitDepth;
                } else {
                    payload.append('bitDepth', bitDepth);
                }
            }

            if (format === 'flac') {
                const compEl = document.getElementById('compressionLevelRange');
                const compVal = compEl ? compEl.value : '5';
                if (!isFormData) payload.compressionLevel = compVal;
                else payload.append('compressionLevel', compVal);
            }

            const response = await fetch('/api/jobs', {
                method: 'POST',
                headers: isFormData ? {} : { 'Content-Type': 'application/json' },
                body: isFormData ? payload : JSON.stringify(payload)
            });

            if (!response.ok) {
                const e = await response.json().catch(() => ({}));
                const msg = e?.error?.code ? this.app.t(`errors.${e.error.code}`) : (e?.error?.message || 'error');
                throw new Error(msg);
            }

            const result = await response.json();
            console.log("Job oluşturuldu:", result);

            if (result.clientBatch) {
                this.jobToBatch.set(result.id, result.clientBatch);
                this.ensureBatch(result.clientBatch, result.batchTotal, {
                    format: result.format,
                    bitrate: result.bitrate,
                    source: result.source
                });
                this.trackJob(result.id, result.clientBatch);
            } else {
                const empty = document.getElementById('job-empty');
                if (empty) empty.remove();
                this.trackJob(result.id);
            }

            this.app.showNotification(this.app.t('notif.queue'), 'success', 'queue');
        } catch (error) {
            console.error("Job gönderme hatası:", error);
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        }
    }
}

export const jobsPanelManager = new JobsPanelManager();
