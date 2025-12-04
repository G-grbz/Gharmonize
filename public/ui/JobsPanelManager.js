export class JobsPanelManager {
    constructor() {
        this.tokenKey = "gharmonize_admin_token";
        this.panel = null;
        this.overlay = null;
        this.list = null;
        this.state = {
            items: [],
            hasUpdate: false,
            latestVersion: null,
            releaseUrl: null
        };
        this.filter = 'active';
        this.eventSource = null;
        this.isStarted = false;
        this.pollingInterval = null;
        this.tokenCheckInterval = null;
        this.progressCache = new Map();
        this.completedAtCache = new Map();
        this.storageKey = 'gharmonize_jobs_panel_state';
    }

    initialize() {
        if (this.isStarted) return;

        this.panel = document.getElementById('jobsPanel');
        this.overlay = document.getElementById('jobsOverlay');
        this.list = document.getElementById('jobsList');
        this.setupEventListeners();
        this.isStarted = true;
        this.startTokenCheck();
        this.restoreState().catch(e => {
            console.warn('[JobsPanel] restoreState error:', e);
        });

        try {
            const latestVersion = localStorage.getItem('gharmonize_latest_version');
            const storedReleaseUrl = localStorage.getItem('gharmonize_latest_release_url');
            const currentVersion =
                window.versionManager?.currentVersion ||
                (() => {
                    try {
                        return localStorage.getItem('gharmonize_current_version');
                    } catch {
                        return null;
                    }
                })() ||
                null;

            if (latestVersion && currentVersion) {
                let isNewer = false;

                if (window.versionManager && typeof window.versionManager.isNewerVersion === 'function') {
                    isNewer = window.versionManager.isNewerVersion(latestVersion, currentVersion);
                } else {
                    isNewer = this.isNewerVersionFallback(latestVersion, currentVersion);
                }

                if (isNewer) {
                    this.state.hasUpdate = true;
                    this.state.latestVersion = latestVersion;
                    this.state.releaseUrl =
                    storedReleaseUrl ||
                    (window.versionManager?.githubRepo
                    ? `https://github.com/${window.versionManager.githubRepo}/releases/tag/v${latestVersion}`
                  : null);
                }
            }
        } catch (e) {
            console.warn('[JobsPanel] update banner init error:', e);
        }

        if (this.state.hasUpdate) {
            this.render();
        }

        if (localStorage.getItem(this.tokenKey)) {
            this.goOnline();
        } else {
            this.goOffline();
        }
    }

    startTokenCheck() {
        this.tokenCheckInterval = setInterval(() => {
            this.checkTokenValidity();
        }, 100000);
    }

    async checkTokenValidity() {
        const token = localStorage.getItem(this.tokenKey);
        if (!token) {
            this.handleTokenExpired();
            return;
        }

        try {
            const response = await fetch('/api/auth/verify', {
                headers: { 'Authorization': 'Bearer ' + token }
            });

            if (!response.ok) {
                this.handleTokenExpired();
            }
        } catch (error) {
            console.error('Token check error:', error);
            this.handleTokenExpired();
        }
    }

    handleTokenExpired() {
        console.log('Token expired or invalid, going offline');
        localStorage.removeItem(this.tokenKey);
        this.goOffline();
        window.dispatchEvent(new CustomEvent('gharmonize:auth', {
            detail: { loggedIn: false }
        }));
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
        const panel = this.panel;
        if (!panel) return;
        panel.setAttribute('aria-hidden', 'false');
        panel.removeAttribute('inert');
        this.overlay && (this.overlay.hidden = false);
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(() => {
            const closeBtn = document.getElementById('jobsClose');
            closeBtn?.focus();
        });
    }

    close() {
        const panel = this.panel;
        if (!panel) return;
        panel.setAttribute('aria-hidden', 'true');
        panel.setAttribute('inert', '');
        this.overlay && (this.overlay.hidden = true);
        document.body.style.overflow = '';
        const jobsBell = document.getElementById('jobsBell');
        if (jobsBell && !jobsBell.hidden) {
            jobsBell.focus();
        }
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
    const jobsBell = document.getElementById('jobsBell');
    if (jobsBell) {
        jobsBell.hidden = true;
    }

    this.close();
    this.eventSource?.close();
    this.eventSource = null;

    if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
    }
}

    destroy() {
        if (this.tokenCheckInterval) {
            clearInterval(this.tokenCheckInterval);
            this.tokenCheckInterval = null;
        }
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.eventSource?.close();
        this.isStarted = false;
    }

    startSSE() {
        try {
            const token = localStorage.getItem(this.tokenKey) || "";
            this.eventSource = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);

            this.eventSource.onmessage = async (ev) => {
    try {
        const incoming = JSON.parse(ev.data) || { items: [] };
        const { hasUpdate, latestVersion, releaseUrl } = this.state;
        const serverItems = Array.isArray(incoming.items) ? incoming.items : [];
        const cleanedItems = await this.cleanupServerItems(serverItems);
        const existingAfterReconcile = await this.reconcileLostJobs(
            this.state.items || [],
            cleanedItems
        );
        const mergedItems = this.mergeItems(existingAfterReconcile, cleanedItems);
        const limitedItems = this.limitCompleted(mergedItems, 15);

        this.state = {
            items: limitedItems,
            hasUpdate,
            latestVersion,
            releaseUrl
        };

        this.saveState();
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
            .then(async d => {
            if (d) {
            const { hasUpdate, latestVersion, releaseUrl } = this.state;
            const serverItems = Array.isArray(d.items) ? d.items : [];
            const cleanedItems = await this.cleanupServerItems(serverItems);

            const existingAfterReconcile = await this.reconcileLostJobs(
                this.state.items || [],
                cleanedItems
            );

            const mergedItems = this.mergeItems(existingAfterReconcile, cleanedItems);
            const limitedItems = this.limitCompleted(mergedItems, 15);

            this.state = {
                items: limitedItems,
                hasUpdate,
                latestVersion,
                releaseUrl
            };

            this.saveState();
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

    isNewerVersionFallback(latest, current) {
        if (!latest) return false;

        const latestParts  = String(latest).split('.').map(Number);
        const currentParts = String(current).split('.').map(Number);

        for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
            const lp = latestParts[i] || 0;
            const cp = currentParts[i] || 0;
            if (lp > cp) return true;
            if (lp < cp) return false;
        }
        return false;
    }

    titleOf(j) {
        const m = j.metadata || {};
        const ex = m.extracted || {};
        return m.frozenTitle || m.spotifyTitle || ex.title || m.originalName ||
               (m.isAutomix ? this.t('jobsPanel.automix') : (m.isPlaylist ? this.t('jobsPanel.playlist') : this.t('jobsPanel.job')));
    }

    getHwaccelIcon(hwaccel) {
        const icons = {
            nvenc: '🔵',
            qsv: '🔶',
            vaapi: '🟣',
            off: '⚪'
        };
        return icons[hwaccel] || '⚪';
    }

    getChannelsText(channels) {
        const texts = {
            stereo: this.t('option.forceStereo') || '2.0',
            mono: this.t('option.forceMono') || '1.0',
            original: this.t('option.auto') || 'Orig'
        };
        return texts[channels] || channels;
    }

    sourcePill(j) {
        const s = j.metadata?.source || 'file';
        const sources = {
           youtube: `▶️ ${this.t('jobsPanel.sourceYouTube')}`,
            spotify: `🎵 ${this.t('jobsPanel.sourceSpotify')}`,
            direct_url: `🌐 ${this.t('jobsPanel.sourceURL')}`,
            file: `💾 ${this.t('jobsPanel.sourceFile')}`,
            local: `💻 ${this.t('jobsPanel.sourceLocal')}`
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

    rawProg(j) {
        if (typeof j.progress === 'number') return j.progress;
        const d = j.downloadProgress || 0;
        const c = j.convertProgress || 0;
        return Math.floor((d + c) / 2);
    }

        prog(j) {
        const id = j.id ?? j._id ?? null;
        const baseRaw = this.rawProg(j);

        if (!Number.isFinite(baseRaw)) return 0;

        const status = this.norm(j.status);
        const prev = (id && this.progressCache.has(id))
            ? this.progressCache.get(id)
            : 0;

        let next = baseRaw;

        if (status !== 'completed') {
            if (next > 95) next = 95;
        } else {
            next = 100;
        }
        if (next < prev) next = prev;

        if (id) {
            this.progressCache.set(id, next);
        }
        return next;
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

            async jobHasExistingOutputPanel(job) {
        const s = this.norm(job.status);
        if (s !== 'completed') return true;

        const candidates = [];
        if (typeof job.resultPath === 'string' && job.resultPath) {
            candidates.push(job.resultPath);
        }
        else if (Array.isArray(job.resultPath)) {
            const firstOk = job.resultPath.find(r => r && r.outputPath && !r.error);
            if (firstOk && firstOk.outputPath) {
                candidates.push(firstOk.outputPath);
            }
            if (!candidates.length && job.zipPath) {
                candidates.push(job.zipPath);
            }
        }
        else if (job.resultPath && typeof job.resultPath === 'object') {
            if (job.resultPath.outputPath) {
                candidates.push(job.resultPath.outputPath);
            }
        }
        else if (job.zipPath) {
            candidates.push(job.zipPath);
        }

        if (!candidates.length) return false;

        const url = candidates[0];

        try {
            const resp = await fetch(url, { method: 'HEAD' });
            if (resp.status === 404) {
                return false;
            }
            return true;
        } catch (e) {
            console.warn('[JobsPanel] jobHasExistingOutputPanel HEAD error:', e);
            return true;
        }
    }

        async prunePlaylistOutputsPanel(job) {
        const s = this.norm(job.status);
        if (s !== 'completed') return true;

        if (!Array.isArray(job.resultPath)) return true;

        const keptResults = [];

        for (const r of job.resultPath) {
            if (!r || r.error) continue;

            let raw = r.outputPath || r.path;
            if (!raw) continue;

            try {
                const resp = await fetch(raw, { method: 'HEAD' });

                if (resp.status === 404) {
                    continue;
                }

                keptResults.push(r);
            } catch (e) {
                console.warn('[JobsPanel] prunePlaylistOutputsPanel HEAD error:', e);
                keptResults.push(r);
            }
        }

        if (job.zipPath) {
            try {
                const zipResp = await fetch(job.zipPath, { method: 'HEAD' });
                if (zipResp.status === 404) {
                    job.zipPath = null;
                }
            } catch (e) {
                console.warn('[JobsPanel] prunePlaylistOutputsPanel zip HEAD error:', e);
            }
        }

        if (keptResults.length === 0 && !job.zipPath) {
            return false;
        }

        job.resultPath = keptResults;
        return true;
    }

    async cleanupServerItems(items) {
        const cleaned = [];

        for (const job of items || []) {
            const status = this.norm(job.status);

            if (status === 'completed') {
                const knownTs = this.completedAtCache.get(job.id);
                const ts = job.completedAt || knownTs || Date.now();
                job.completedAt = ts;
                this.completedAtCache.set(job.id, ts);

                let keep = true;

                if (Array.isArray(job.resultPath)) {
                    keep = await this.prunePlaylistOutputsPanel(job);
                } else {
                    keep = await this.jobHasExistingOutputPanel(job);
                }

                if (!keep) {
                    continue;
                }
            } else {
                const knownTs = this.completedAtCache.get(job.id);
                if (knownTs && !job.completedAt) {
                    job.completedAt = knownTs;
                }
            }
            cleaned.push(job);
        }
        return cleaned;
    }

        async reconcileLostJobs(existing, incoming) {
        const safeExisting = Array.isArray(existing) ? existing : [];
        const safeIncoming = Array.isArray(incoming) ? incoming : [];
        const incomingIds = new Set(
            safeIncoming
                .map(j => j?.id ?? j?._id)
                .filter(Boolean)
        );

        const result = [];

        for (const job of safeExisting) {
            if (!job) continue;

            const id = job.id ?? job._id;
            if (!id) {
                result.push(job);
                continue;
            }

            if (incomingIds.has(id)) {
                result.push(job);
                continue;
            }

            const status = this.norm(job.status);
            if (status === 'completed') {
                let keep = true;

                if (Array.isArray(job.resultPath)) {
                    keep = await this.prunePlaylistOutputsPanel(job);
                } else {
                    keep = await this.jobHasExistingOutputPanel(job);
                }

                if (keep) {
                    result.push(job);
                }
                continue;
            }

            let keep = true;

            if (Array.isArray(job.resultPath)) {
                keep = await this.prunePlaylistOutputsPanel(job);
            } else if (job.resultPath || job.zipPath) {
                keep = await this.jobHasExistingOutputPanel(job);
            } else {
                keep = false;
            }

            if (!keep) {
                continue;
            }
            result.push(job);
        }
        return result;
    }

    mergeItems(existing, incoming) {
        const result = [];
        const byId = new Map();

        const add = (job, isExisting = false) => {
            if (!job) return;
            const id = job.id ?? job._id;
            if (!id) {
                result.push(job);
                return;
            }

            const prev = byId.get(id);
            if (!prev) {
                byId.set(id, job);
                result.push(job);
            } else {
                const merged = { ...prev, ...job };
                if (prev.completedAt && !merged.completedAt) {
                    merged.completedAt = prev.completedAt;
                }

                byId.set(id, merged);

                const idx = result.findIndex(x => (x.id ?? x._id) === id);
                if (idx >= 0) {
                    result[idx] = merged;
                }
            }
        };

        (existing || []).forEach(j => add(j, true));
        (incoming || []).forEach(j => add(j, false));

        return result;
    }

        limitCompleted(items, maxCompleted = 15) {
        if (!Array.isArray(items)) return [];

        const active = [];
        const completed = [];

        for (const j of items) {
            const s = this.norm(j?.status);
            if (s === 'completed') {
                completed.push(j);
            } else {
                active.push(j);
            }
        }

        completed.sort((a, b) => {
            const ta = a.completedAt || 0;
            const tb = b.completedAt || 0;
            return tb - ta;
        });

        return [...active, ...completed.slice(0, maxCompleted)];
    }

        saveState() {
        try {
            const items = this.limitCompleted(this.state.items || [], 15);

            const payload = {
                items,
                savedAt: Date.now(),
                version: 1
            };

            localStorage.setItem(this.storageKey, JSON.stringify(payload));
        } catch (e) {
            console.warn('[JobsPanel] saveState error:', e);
        }
    }

    async restoreState() {
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) return;

            const data = JSON.parse(raw);
            if (!data || !Array.isArray(data.items)) return;

            const cleaned = await this.cleanupServerItems(data.items || []);
            const limited = this.limitCompleted(cleaned, 15);
            const { hasUpdate, latestVersion, releaseUrl } = this.state;
            this.state = {
                items: limited,
                hasUpdate,
                latestVersion,
                releaseUrl
            };
            this.render();
        } catch (e) {
            console.warn('[JobsPanel] restoreState parse error:', e);
            try { localStorage.removeItem(this.storageKey); } catch (_) {}
        }
    }

        updateJobsBell() {
        const allItems = Array.isArray(this.state.items)
            ? this.state.items
            : [];

        const activeCount = allItems.filter(j =>
            !['completed', 'error', 'canceled'].includes(this.norm(j.status))
        ).length;

        const badge = document.getElementById('jobsBadge');
        const bell  = document.getElementById('jobsBell');
        if (!badge || !bell) return;

        const baseCount = activeCount;
        const displayCount = this.state.hasUpdate
            ? baseCount + 1
            : baseCount;

        const prev = Number(badge.dataset.count || 0);
        badge.dataset.count = String(displayCount);
        if (displayCount > 0) {
            badge.textContent = String(displayCount);
            badge.title = this.t('version.badgeTitle', { count: displayCount });
            badge.hidden = false;
        } else {
            badge.textContent = '';
            badge.removeAttribute('title');
            badge.hidden = true;
        }

        const hasToken = !!localStorage.getItem(this.tokenKey);
        if (!hasToken) {
            bell.hidden = true;
            bell.classList.remove('jobs-bell--active', 'jobs-bell--ping');
            return;
        }

        bell.hidden = false;

        if (displayCount > 0) {
            bell.classList.add('jobs-bell--active');
        } else {
            bell.classList.remove('jobs-bell--active');
            bell.classList.remove('jobs-bell--ping');
        }

        if (displayCount > prev) {
            bell.classList.add('jobs-bell--ping');
            setTimeout(() => {
                bell.classList.remove('jobs-bell--ping');
            }, 900);
        }
    }

    render() {
    if (!this.list) return;
    const prevScrollTop = this.list.scrollTop;

    const allItems = Array.isArray(this.state.items)
        ? this.state.items.slice()
        : [];

    const items = (this.filter === 'active')
        ? allItems.filter(j => !['completed', 'error', 'canceled'].includes(this.norm(j.status)))
        : allItems;

        items.sort((a, b) => {
            const sa = this.norm(a.status);
            const sb = this.norm(b.status);
            const ta = a.completedAt || 0;
            const tb = b.completedAt || 0;

            if (sa === 'completed' && sb === 'completed') return tb - ta;
            if (sa === 'completed' && sb !== 'completed') return -1;
            if (sb === 'completed' && sa !== 'completed') return 1;
            return 0;
        });

      this.updateJobsBell();

    let updateNotification = '';
    if (this.state.hasUpdate) {
        updateNotification = `
            <div class="update-notification" style="
                background: linear-gradient(135deg, var(--success-light) 0%, var(--accent-light) 100%);
                border: 1px solid var(--success);
                border-radius: 12px;
                padding: 16px;
                margin: 0 16px 16px 16px;
                display: flex;
                align-items: center;
                gap: 12px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            ">
                <div style="font-size: 24px; flex-shrink: 0;">🔄</div>
                <div style="flex: 1;">
                    <div style="font-weight: 700; color: var(--success); margin-bottom: 4px; font-size: 14px;">
                        ${this.t('version.updateAvailable')}
                    </div>
                    <div style="font-size: 13px; color: var(--text-muted);">
                        <strong>v${this.state.latestVersion}</strong> - ${this.t('version.viewDetails')}
                    </div>
                </div>
                <div style="display: flex; gap: 8px; flex-shrink: 0;">
                    <button
                        type="button"
                        class="btn-outline btn-sm jobs-update-view"
                        style="padding: 6px 12px; font-size: 12px; border-radius: 6px;"
                    >
                        ${this.t('btn.view')}
                    </button>
                    <button
                        type="button"
                        class="btn-primary btn-sm jobs-update-dismiss"
                        style="padding: 6px 12px; font-size: 12px; border-radius: 6px; background: var(--success); border-color: var(--success);"
                    >
                        ${this.t('btn.close')}
                    </button>
                </div>
            </div>
        `;
    }

    if (items.length === 0) {
        const isActive = (this.filter === 'active');
        this.list.innerHTML = `
            ${updateNotification}
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

        const viewBtnEmpty = this.list.querySelector('.jobs-update-view');
        if (viewBtnEmpty && window.versionManager?.viewRelease) {
            viewBtnEmpty.addEventListener('click', () => {
                window.versionManager.viewRelease();
            });
        }

        const dismissBtnEmpty = this.list.querySelector('.jobs-update-dismiss');
        if (dismissBtnEmpty && window.versionManager?.dismissUpdate) {
            dismissBtnEmpty.addEventListener('click', () => {
                window.versionManager.dismissUpdate();
            });
        }

        this.list.scrollTop = prevScrollTop;
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

        const fmt = String(j.format || '').toLowerCase();
        const videoFormats = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
        const audioFormats = ['mp3', 'aac', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'alac', 'eac3', 'ac3'];

        let formatEmoji = '📁';
        if (videoFormats.includes(fmt)) {
            formatEmoji = '🎬';
        } else if (audioFormats.includes(fmt)) {
            formatEmoji = '🎧';
        }

        const fpsEmoji = '🎯';
        const sampleRateEmoji = '📡';
        const channelsEmoji = '🎚️';
        const bitrateEmoji = '📶';

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

        let completedAtInfo = '';
        if (this.norm(j.status) === 'completed' && j.completedAt) {
            const d = new Date(j.completedAt);
            const formatted = d.toLocaleString();
            completedAtInfo = `
                <div class="muted" style="font-size:12px;margin-top:4px;">
                    🕒 ${formatted}
                </div>
            `;
        }

        return `
            <div class="job-card" data-job-id="${j.id}">
                <div class="job-title">${this.statusDot(j)}<span>${titleText}</span></div>

                <div class="job-meta">
                    <span class="pill">${this.sourcePill(j)}</span>
                    <span class="pill">${formatEmoji} ${(j.format || '').toUpperCase()} ${j.bitrate ? `• ${bitrateEmoji} ${j.bitrate}` : ''}</span>
                    ${j.sampleRate ? `
                        <span class="pill">
                            ${sampleRateEmoji} ${Math.round(j.sampleRate / 1000)} ${this.t('ui.khz') || 'kHz'}
                        </span>
                    ` : ''}
                    ${j.videoSettings?.transcodeEnabled ? `
                        <span class="pill pill--video" title="${this.t('label.videoTranscodejob')}">🎬</span>
                    ` : ''}
                    ${j.videoSettings?.audioTranscodeEnabled ? `
                        <span class="pill pill--audio" title="${this.t('label.audioTranscode')}">🎵</span>
                    ` : ''}
                    ${j.videoSettings?.hwaccel && j.videoSettings.hwaccel !== 'off' ? `
                        <span
                            class="pill pill--hwaccel"
                            title="${this.t('label.hwaccel')}: ${this.t(`option.${j.videoSettings.hwaccel}`) || j.videoSettings.hwaccel}"
                        >
                            ${this.getHwaccelIcon(j.videoSettings.hwaccel)}
                        </span>
                    ` : ''}
                    ${j.videoSettings?.fps && j.videoSettings.fps !== 'source' ?
                        `<span class="pill" title="FPS">${fpsEmoji} ${j.videoSettings.fps} ${this.t('ui.fps') || 'FPS'}</span>` : ''}
                    ${j.videoSettings?.audioChannels && j.videoSettings.audioChannels !== 'original' ?
                        `<span class="pill" title="${this.t('label.stereoConvert')}">
                            ${channelsEmoji} ${this.getChannelsText(j.videoSettings.audioChannels)}
                        </span>` : ''}
                    ${j.videoSettings?.audioSampleRate && j.videoSettings.audioSampleRate !== '48000' ?
                        `<span class="pill" title="${this.t('label.sampleRate')}">
                            ${sampleRateEmoji} ${parseInt(j.videoSettings.audioSampleRate)/1000}k
                        </span>` : ''}
                    ${j.videoSettings?.audioCodec && j.videoSettings.audioCodec !== 'aac' ?
                        `<span class="pill" title="${this.t('label.format')}">${this.t(`option.${j.videoSettings.audioCodec}`) || j.videoSettings.audioCodec.toUpperCase()}</span>` : ''}
                    ${j.videoSettings?.audioBitrate && j.videoSettings.audioBitrate !== '192k' ?
                        `<span class="pill" title="${this.t('label.audioBitrate')}">
                            ${bitrateEmoji} ${j.videoSettings.audioBitrate}
                        </span>` : ''}
                    ${j.metadata?.includeLyrics ? `
                        <span class="pill pill--lyrics" title="${this.t('label.includeLyrics2')}">🎼</span>
                    ` : ''}
                    ${j.metadata?.volumeGain && j.metadata.volumeGain !== 1.0 ? `
                        <span class="pill pill--volume" title="${this.t('label.volumeGain')}">🔊 ${j.metadata.volumeGain}x</span>
                    ` : ''}
                    <span class="pill">${this.phasePill(j)}</span>
                    ${skippedBadge}
                </div>

                ${(() => {
                    const nt = nowT;
                    return nt ? `<div class="muted" style="font-size:12px">▶️ <strong>${nt}</strong></div>` : '';
                })()}

                ${cancelInfo}
                ${completedAtInfo}

                <div class="progress panel" role="progressbar"
                     aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}">
                    <span style="width:${p}%"></span>
                </div>

                <div class="row panel">
                    <span>${p}%</span>
                    <span style="display:flex; gap:8px; align-items:center;">
                        ${downloadLinks}
                        <button class="btn-danger" data-stop-panel="${j.id}" ${(['completed', 'error', 'canceled'].includes(this.norm(j.status))) ? 'disabled' : ''} title="${this.t('btn.stop')}">
                            ${this.t('btn.stop')}
                        </button>
                    </span>
                </div>
            </div>
        `;
    }).join('');

    if (this.filter === 'active') {
        const activeTitleKey = 'jobsPanel.activeGroupTitle';
        const activeTitle = this.t(activeTitleKey);

        this.list.innerHTML = `
            ${updateNotification}
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
        this.list.innerHTML = `
            ${updateNotification}
            ${jobsHtml}
        `;
    }

    if (window.i18n?.apply) window.i18n.apply(this.list);
    if (this.filter === 'active' && items.length > 0) {
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

    const viewBtn = this.list.querySelector('.jobs-update-view');
        if (viewBtn) {
            viewBtn.addEventListener('click', () => {
                const url = this.state.releaseUrl;
                if (url) {
                    window.open(url, '_blank');
                }
            });
        }

    const dismissBtn = this.list.querySelector('.jobs-update-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                this.state.hasUpdate = false;
                this.render();
            });
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

    this.list.scrollTop = prevScrollTop;
    this.saveState();
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
        this.storageKey = 'gharmonize_job_session';

        if (typeof window !== 'undefined') {
            const doRestore = () => {
                try {
                    this.restoreSessionState();
                } catch (e) {
                    console.warn('[JobManager] restoreSessionState failed:', e);
                }
            };

            if (document.readyState === 'loading') {
                window.addEventListener('DOMContentLoaded', doRestore, { once: true });
            } else {
                doRestore();
            }
        }
    }

        trackJob(jobId, batchId = null) {
        if (this.currentJobs.has(jobId)) return;

        const maxRetries = 3;

        const startJobSSE = (retryCount = 0) => {
            const eventSource = new EventSource(`/api/stream/${jobId}`);
            this.currentJobs.set(jobId, eventSource);

            let firstUpdate = (retryCount === 0);

            eventSource.onmessage = (event) => {
                const job = JSON.parse(event.data);
                job.status = this.normalizeStatus(job.status);
                job.currentPhase = this.normalizeStatus(job.currentPhase);
                job.phase = this.normalizeStatus(job.phase);

                this.jobStates.set(jobId, job);

                const isTerminal = ['completed', 'error', 'canceled'].includes(job.status);

                if (firstUpdate || isTerminal) {
                    try {
                        this.saveSessionState();
                    } catch (e) {
                        console.warn('[JobManager] autosave after SSE update failed:', e);
                    }
                }

                if (firstUpdate) {
                    firstUpdate = false;
                    document.dispatchEvent(new CustomEvent('job:first-update', { detail: { jobId, job } }));
                }

                this.updateJobUI(job, batchId);

                if (isTerminal) {
                    eventSource.close();
                    this.currentJobs.delete(jobId);
                }
            };

            eventSource.onerror = (error) => {
            console.error('SSE error:', error, 'retry:', retryCount);
            eventSource.close();
            this.currentJobs.delete(jobId);

            const maxRetries = 1;

            if (retryCount < maxRetries) {
                const delay = 500 * (retryCount + 1);
                setTimeout(() => {
                    startJobSSE(retryCount + 1);
                }, delay);
                return;
            }

            (async () => {
                await new Promise(r => setTimeout(r, 2000));

                try {
                    const job = this.jobStates.get(jobId);
                    if (!job) return;

                    const statusNow = this.normalizeStatus(job.status);
                    if (['completed', 'error', 'canceled'].includes(statusNow)) {
                        this.saveSessionState();
                        return;
                    }

                    let resolvedJob = null;
                    let probeDone   = false;

                    let adminToken = null;
                    try {
                        adminToken = localStorage.getItem('gharmonize_admin_token');
                    } catch (_) {
                        adminToken = null;
                    }

                    if (adminToken) {
                        try {
                            const resp = await fetch('/api/jobs?status=all', {
                                headers: { 'Authorization': 'Bearer ' + adminToken }
                            });

                            if (resp.ok) {
                                const data  = await resp.json().catch(() => null);
                                const items = data && Array.isArray(data.items) ? data.items : [];
                                resolvedJob = items.find(x => x.id === jobId) || null;
                                probeDone   = true;
                            } else if (resp.status === 404) {
                                probeDone   = true;
                                resolvedJob = null;
                            }
                        } catch (err) {
                            console.warn('[JobManager] status probe after SSE error failed:', err);
                        }
                    }

                    if (probeDone && resolvedJob) {
                        const serverStatus = this.normalizeStatus(resolvedJob.status);
                        job.status       = serverStatus;
                        job.phase        = this.normalizeStatus(resolvedJob.phase || job.phase);
                        job.currentPhase = this.normalizeStatus(resolvedJob.currentPhase || job.currentPhase);
                        if (resolvedJob.resultPath !== undefined) job.resultPath = resolvedJob.resultPath;
                        if (resolvedJob.zipPath    !== undefined) job.zipPath    = resolvedJob.zipPath;
                        this.jobStates.set(jobId, job);
                        this.updateJobUI(job, this.jobToBatch.get(jobId) || null);
                        this.saveSessionState();
                        return;
                    } else if (probeDone && !resolvedJob) {
                        this.removeJobCompletely(jobId);
                        this.app.showNotification(
                            this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                            'info',
                            'action'
                        );
                        return;
                    }

                    if (statusNow !== 'completed') {
                        const hasAnyPath = Boolean(
                            job.resultPath ||
                            (Array.isArray(job.resultPath) && job.resultPath.length) ||
                            job.zipPath
                        );

                        if (!hasAnyPath) {
                            this.removeJobCompletely(jobId);
                            this.app.showNotification(
                                this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                                'info',
                                'action'
                            );
                            return;
                        }

                        job.connectionLost = true;
                        this.jobStates.set(jobId, job);
                        this.updateJobUI(job, this.jobToBatch.get(jobId) || null);
                        this.saveSessionState();
                        return;
                    }

                    let keep = true;

                    if (Array.isArray(job.resultPath)) {
                        keep = await this.prunePlaylistOutputs(job);
                    } else {
                        keep = await this.jobHasExistingOutput(job);
                    }

                    if (!keep) {
                        this.removeJobCompletely(jobId);
                        this.app.showNotification(
                            this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                            'info',
                            'action'
                        );
                        return;
                    } else {
                        job.connectionLost = true;
                        this.jobStates.set(jobId, job);
                        this.updateJobUI(job, this.jobToBatch.get(jobId) || null);
                        this.saveSessionState();
                    }
                } catch (e) {
                    console.warn('[JobManager] autosave after SSE error failed:', e);
                }
            })();
        };
    };
    startJobSSE(0);
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

    getChannelsText(channels) {
       const texts = {
           stereo: '2.0',
           mono: '1.0',
           original: 'Orig'
       };
       return texts[channels] || channels;
   }

   getHwaccelIcon(hwaccel) {
    const icons = {
        nvenc: '🔵',
        qsv: '🔶',
        vaapi: '🟣',
        off: '⚪'
    };
    return icons[hwaccel] || '⚪';
}

getChannelsText(channels) {
    const texts = {
        stereo: '2.0',
        mono: '1.0',
        original: 'Orig'
    };
    return texts[channels] || channels;
}

updateJobUI(job, batchId = null) {
    const statusNorm = this.normalizeStatus(job.status);
    const prev = this.jobStates.get(job.id);
    const prevStatus = this.normalizeStatus(prev?.status);

    if (statusNorm === 'completed') {
        if (!job.completedAt) {
            job.completedAt = prev?.completedAt || Date.now();
        }
    } else if (prev?.completedAt && !job.completedAt) {
        job.completedAt = prev.completedAt;
    }

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

    const fmt = String(job.format || '').toLowerCase();
    const videoFormats = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
    const audioFormats = ['mp3', 'aac', 'm4a', 'ogg', 'opus', 'flac', 'wav', 'alac', 'eac3', 'ac3'];
    const codecIcon = '⚡';

    let formatInnerEmoji = '⚡';
    if (videoFormats.includes(fmt)) {
        formatInnerEmoji = '🎬';
    } else if (audioFormats.includes(fmt)) {
        formatInnerEmoji = '🎧';
    }

    const formatCards = [];
    const bitrateEmoji = '📶';
    const sampleRateEmoji = '📡';
    const fpsEmoji = '🎯';
    const channelsEmoji = '🎚️';
    const basicCards = [];
    const formatFeatures = [];
    formatFeatures.push(`
        <span class="info-feature">
            ${formatInnerEmoji} ${(job.format || '').toUpperCase() || '—'}
        </span>
    `);

    if (job.bitrate) {
        formatFeatures.push(`
            <span class="info-feature">
                ${bitrateEmoji} ${job.bitrate}
            </span>
        `);
    }

    basicCards.push(`
        <div class="info-card info-card--features">
            <div class="info-card__icon">${codecIcon}</div>
            <div class="info-card__content">
                <div class="info-card__title">${this.app.t('label.format')}</div>
                <div class="info-features-grid">
                    ${formatFeatures.join('')}
                </div>
            </div>
        </div>
    `);

    const videoFeatures = [];
    if (job.videoSettings?.transcodeEnabled) {
        videoFeatures.push(`<span class="info-feature">🎬 ${this.app.t('label.videoTranscodejob') || 'Transcode'}</span>`);

        if (job.videoSettings.hwaccel && job.videoSettings.hwaccel !== 'off') {
            const hwaccelText = this.app.t(`option.${job.videoSettings.hwaccel}`) || job.videoSettings.hwaccel.toUpperCase();
            videoFeatures.push(`<span class="info-feature">${this.getHwaccelIcon(job.videoSettings.hwaccel)} ${hwaccelText}</span>`);
        }

        if (job.videoSettings.fps && job.videoSettings.fps !== 'source') {
            videoFeatures.push(`<span class="info-feature">${fpsEmoji} ${job.videoSettings.fps} FPS</span>`);
        }
    }

    const audioFeatures = [];
    if (job.videoSettings?.audioTranscodeEnabled) {
        const audioCodecText =
            this.app.t(`option.${job.videoSettings.audioCodec}`) ||
            job.videoSettings.audioCodec?.toUpperCase() ||
            'AAC';

        audioFeatures.push(`
            <span class="info-feature">
                🎵 ${audioCodecText}
            </span>
        `);

        if (job.videoSettings.audioBitrate && job.videoSettings.audioBitrate !== '192k') {
            audioFeatures.push(`
                <span class="info-feature">
                    ${bitrateEmoji} ${job.videoSettings.audioBitrate}
                </span>
            `);
        }

        if (job.videoSettings.audioChannels && job.videoSettings.audioChannels !== 'original') {
            const channelsText = this.getChannelsText(job.videoSettings.audioChannels);
            audioFeatures.push(`
                <span class="info-feature">
                    ${channelsEmoji} ${channelsText}
                </span>
            `);
        }

        let addedSampleRate = false;
        if (job.videoSettings.audioSampleRate && job.videoSettings.audioSampleRate !== '48000') {
            audioFeatures.push(`
                <span class="info-feature">
                    ${sampleRateEmoji} ${parseInt(job.videoSettings.audioSampleRate, 10) / 1000} kHz
                </span>
            `);
            addedSampleRate = true;
        }

        if (!addedSampleRate && job.sampleRate) {
            audioFeatures.push(`
                <span class="info-feature">
                    ${sampleRateEmoji} ${Math.round(job.sampleRate / 1000)} kHz
                </span>
            `);
        }
    } else if (job.sampleRate) {
        audioFeatures.push(`
            <span class="info-feature">
                ${sampleRateEmoji} ${Math.round(job.sampleRate / 1000)} kHz
            </span>
        `);
    }

    const extraFeatures = [];
    if (job.metadata?.includeLyrics) {
        extraFeatures.push(`<span class="info-feature">🎼 ${this.app.t('label.includeLyrics2') || 'Lyrics'}</span>`);
    }
    if (job.metadata?.volumeGain && job.metadata.volumeGain !== 1.0) {
        extraFeatures.push(`<span class="info-feature">🔊 ${job.metadata.volumeGain}x</span>`);
    }
    if (job.metadata?.isPlaylist) {
        extraFeatures.push(`<span class="info-feature">📜 ${this.app.t('ui.playlist')}</span>`);
    }

    const featureCards = [];
    if (videoFeatures.length > 0) {
        featureCards.push(`
            <div class="info-card info-card--features">
                <div class="info-card__icon">🎬</div>
                <div class="info-card__content">
                    <div class="info-card__title">${this.app.t('label.video')}</div>
                    <div class="info-features-grid">
                        ${videoFeatures.join('')}
                    </div>
                </div>
            </div>
        `);
    }

    if (audioFeatures.length > 0) {
        featureCards.push(`
            <div class="info-card info-card--features">
                <div class="info-card__icon">🎵</div>
                <div class="info-card__content">
                    <div class="info-card__title">${this.app.t('label.audio')}</div>
                    <div class="info-features-grid">
                        ${audioFeatures.join('')}
                    </div>
                </div>
            </div>
        `);
    }

    if (extraFeatures.length > 0) {
        featureCards.push(`
            <div class="info-card info-card--features">
                <div class="info-card__icon">⚙️</div>
                <div class="info-card__content">
                    <div class="info-card__title">${this.app.t('label.extras') || 'Ekstra'}</div>
                    <div class="info-features-grid">
                        ${extraFeatures.join('')}
                    </div>
                </div>
            </div>
        `);
    }

    const allCards = [...basicCards, ...featureCards];
    const formatInfoHTML = `
        <div class="info-cards-grid">
            ${allCards.join('')}
        </div>
    `;

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

    let completedAtInfo = '';
    if (job.completedAt) {
        const d = new Date(job.completedAt);
        const formatted = d.toLocaleString();
        completedAtInfo = `
            <div class="job-time" style="font-size: 12px; color: var(--text-muted); margin: 4px 0;">
                🕒 ${this.app.escapeHtml(formatted)}
            </div>
        `;
    }

    const jobContent = `
        <div class="job-item-content">
            <strong>${this.app.escapeHtml(jobTitle)}</strong>
            <div style="font-size: 13px; color: var(--text-muted); margin: 8px 0;">
                ${phaseInfo}
                ${skippedBadge}
            </div>
            ${formatInfoHTML}
            ${lyricsInfo}
            ${lastLogInfo}
            ${cancelInfo}
            ${completedAtInfo}
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
        </div>
    `;

    if (!jobElement) {
        jobElement = document.createElement('div');
        jobElement.id = `job-${job.id}`;

        if (statusNorm === 'completed') {
            jobElement.className = 'job-item job-item--collapsible';
            const isExpanded = false;
            jobElement.innerHTML = `
                <button class="job-item-header" aria-expanded="${isExpanded}">
                    <div class="job-item-header__content">
                        <span class="job-item-header__title">${this.app.escapeHtml(jobTitle)}</span>
                        <span class="job-item-header__status status status-${job.status}">${statusText[job.status]}</span>
                    </div>
                    <span class="job-item-header__icon" aria-hidden="true">▾</span>
                </button>
                <div class="job-item-body" ${isExpanded ? '' : 'hidden'}>
                    ${jobContent}
                </div>
            `;
        } else {
            jobElement.className = 'job-item';
            jobElement.innerHTML = jobContent;
        }
    } else {
        if (statusNorm === 'completed' && !jobElement.classList.contains('job-item--collapsible')) {
            jobElement.className = 'job-item job-item--collapsible';
            const isExpanded = false;
            jobElement.innerHTML = `
                <button class="job-item-header" aria-expanded="${isExpanded}">
                    <div class="job-item-header__content">
                        <span class="job-item-header__title">${this.app.escapeHtml(jobTitle)}</span>
                        <span class="job-item-header__status status status-${job.status}">${statusText[job.status]}</span>
                    </div>
                    <span class="job-item-header__icon" aria-hidden="true">▾</span>
                </button>
                <div class="job-item-body" ${isExpanded ? '' : 'hidden'}>
                    ${jobContent}
                </div>
            `;
        } else if (statusNorm === 'completed') {
            const header = jobElement.querySelector('.job-item-header');
            const body = jobElement.querySelector('.job-item-body');
            if (header && body) {
                const titleSpan = header.querySelector('.job-item-header__title');
                const statusSpan = header.querySelector('.job-item-header__status');
                if (titleSpan) titleSpan.textContent = this.app.escapeHtml(jobTitle);
                if (statusSpan) statusSpan.textContent = statusText[job.status];
                statusSpan.className = `job-item-header__status status status-${job.status}`;

                body.innerHTML = jobContent;
            }
        } else {
            jobElement.innerHTML = jobContent;
        }
    }

    const parentForJob = ['completed', 'canceled', 'error'].includes(statusNorm)
        ? completedBody
        : activeBody;

    if (parentForJob) {
        const isTerminal = ['completed', 'canceled', 'error'].includes(statusNorm);

        if (isTerminal) {
            parentForJob.insertBefore(jobElement, parentForJob.firstChild || null);
        } else {
            if (jobElement.parentElement !== parentForJob) {
                parentForJob.appendChild(jobElement);
            }
        }
    }

    if (statusNorm === 'completed' || statusNorm === 'error' || statusNorm === 'canceled') {
        const header = jobElement.querySelector('.job-item-header');
        const body = jobElement.querySelector('.job-item-body');
        if (header && body) {
            if (!header.dataset.hasListener) {
                header.addEventListener('click', () => {
                    const expanded = header.getAttribute('aria-expanded') === 'true';
                    header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
                    body.hidden = expanded;
                    header.classList.toggle('is-collapsed', expanded);
                });
                header.dataset.hasListener = 'true';
            }
        }
    }

    this.jobStates.set(job.id, job);

    let activeCount = 0;
    let completedCount = 0;
    for (const j of this.jobStates.values()) {
        const s = this.normalizeStatus(j.status);
        if (['completed', 'canceled', 'error'].includes(s)) {
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
    const newStopBtn = stopBtn.cloneNode(true);
    stopBtn.parentNode.replaceChild(newStopBtn, stopBtn);

    newStopBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        newStopBtn.disabled = true;

        try {
            const r = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
                method: 'POST'
            });

            if (r.status === 404) {
                this.removeJobCompletely(job.id);
                this.app.showNotification(
                    this.app.t('errors.jobLost') || 'İş sunucuda bulunamadı, listeden kaldırıldı.',
                    'info',
                    'action'
                );
                return;
            }
            if (!r.ok) {
                const eData = await r.json().catch(() => ({}));
                throw new Error(eData?.error?.message || this.app.t('notif.cancelFailed'));
            }
            const js = this.jobStates.get(job.id) || {};
            js.status = 'canceled';
            js.phase = 'canceled';
            js.currentPhase = 'canceled';
            this.jobStates.set(job.id, js);
            this.updateJobUI(js, this.jobToBatch.get(job.id) || null);

            this.app.showNotification(this.app.t('notif.canceledByUser'), 'success', 'action');
            this.saveSessionState();
        } catch (e) {
            newStopBtn.disabled = false;
            this.app.showNotification(
                `${this.app.t('notif.cancelFailed')}: ${e.message}`,
                'error',
                'error'
            );
            this.saveSessionState();
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
            jobs: new Set(),
            meta: meta || {}
        };

        this.batches.set(batchId, batch);
        const stopBtn = batchElement.querySelector(`[data-stop-batch="${batchId}"]`);
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.cancelBatch(batchId));
        }
        this.saveSessionState();
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

    removeJobCompletely(jobId) {
    const batchId = this.jobToBatch.get(jobId) || null;
    this.jobStates.delete(jobId);

    if (batchId && this.batches.has(batchId)) {
        const batch = this.batches.get(batchId);
        batch.jobs.delete(jobId);
        this.updateBatchProgress(batchId);
        if (batch.jobs.size === 0 && batch.el && batch.el.parentElement) {
            batch.el.parentElement.removeChild(batch.el);
            this.batches.delete(batchId);
        }
    }

    const el = document.getElementById(`job-${jobId}`);
    if (el && el.parentElement) {
        el.parentElement.removeChild(el);
    }

    let activeCount = 0;
    let completedCount = 0;
    for (const j of this.jobStates.values()) {
        const s = this.normalizeStatus(j.status);
        if (['completed', 'canceled', 'error'].includes(s)) {
            completedCount++;
        } else {
            activeCount++;
        }
    }
    const activeBadge = document.getElementById('session-active-count');
    const completedBadge = document.getElementById('session-completed-count');
    if (activeBadge) activeBadge.textContent = String(activeCount);
    if (completedBadge) completedBadge.textContent = String(completedCount);
    this.saveSessionState();
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
        this.saveSessionState();
    }

        shouldPersistJob(job) {
        const s = this.normalizeStatus(job.status);
        if (s === 'canceled' || s === 'error') {
            return false;
        }
        return true;
    }
        saveSessionState() {
        try {
            const all = Array.from(this.jobStates.values())
                .filter(job => this.shouldPersistJob(job));

            const activeJobs = all.filter(job => {
                const s = this.normalizeStatus(job.status);
                return s !== 'completed';
            });

            const completedJobs = all.filter(job => {
                const s = this.normalizeStatus(job.status);
                return s === 'completed';
            });

            completedJobs.sort((a, b) => {
                const ta = a.completedAt || 0;
                const tb = b.completedAt || 0;
                return tb - ta;
            });

            const limitedCompleted = completedJobs.slice(0, 15);
            const jobs = [...activeJobs, ...limitedCompleted];
            const validIds = new Set(jobs.map(j => j.id));
            const batches = Array.from(this.batches.entries())
                .map(([id, b]) => ({
                    id,
                    total: b.total,
                    meta: b.meta || {},
                    jobs: Array.from(b.jobs || []).filter(jobId => validIds.has(jobId))
                }))
                .filter(b => b.jobs.length > 0);

            const jobToBatch = {};
            this.jobToBatch.forEach((batchId, jobId) => {
                if (validIds.has(jobId)) {
                    jobToBatch[jobId] = batchId;
                }
            });

            const payload = {
                jobs,
                batches,
                jobToBatch,
                savedAt: Date.now(),
                version: 1
            };

            localStorage.setItem(this.storageKey, JSON.stringify(payload));
        } catch (e) {
            console.warn('[JobManager] saveSessionState error:', e);
        }
    }

        async jobHasExistingOutput(job) {
            const s = this.normalizeStatus(job.status);
            if (s !== 'completed') return true;

            const candidates = [];

            if (typeof job.resultPath === 'string' && job.resultPath) {
                candidates.push(job.resultPath);
            }
            else if (Array.isArray(job.resultPath)) {
                const firstOk = job.resultPath.find(r => r && r.outputPath && !r.error);
                if (firstOk && firstOk.outputPath) candidates.push(firstOk.outputPath);
                if (!candidates.length && job.zipPath) {
                    candidates.push(job.zipPath);
                }
            }
            else if (job.resultPath && typeof job.resultPath === 'object') {
                if (job.resultPath.outputPath) {
                    candidates.push(job.resultPath.outputPath);
                }
            }
            else if (job.zipPath) {
                candidates.push(job.zipPath);
            }

            if (!candidates.length) return false;

            const url = this.app.toRelative(candidates[0]);

            try {
                const resp = await fetch(url, { method: 'HEAD' });
                if (resp.status === 404) {
                    return false;
                }

                return true;
            } catch (e) {
                console.warn('[JobManager] jobHasExistingOutput fetch error:', e);
                return true;
            }
        }

        async prunePlaylistOutputs(job) {
            const s = this.normalizeStatus(job.status);
            if (s !== 'completed') return true;

            if (!Array.isArray(job.resultPath)) {
                return true;
            }

            const keptResults = [];

            for (const r of job.resultPath) {
                if (!r || r.error) continue;

                let raw = r.outputPath || r.path;
                if (!raw) continue;

                const url = this.app.toRelative(raw);

                try {
                    const resp = await fetch(url, { method: 'HEAD' });

                    if (resp.status === 404) {
                        continue;
                    }
                    keptResults.push(r);
                } catch (e) {
                    console.warn('[JobManager] prunePlaylistOutputs HEAD error:', e);
                    keptResults.push(r);
                }
            }

            if (job.zipPath) {
                try {
                    const zipResp = await fetch(this.app.toRelative(job.zipPath), { method: 'HEAD' });

                    if (zipResp.status === 404) {
                        job.zipPath = null;
                    }
                } catch (e) {
                    console.warn('[JobManager] prunePlaylistOutputs zip HEAD error:', e);
                }
            }

            if (keptResults.length === 0 && !job.zipPath) {
                return false;
            }

            job.resultPath = keptResults;
            return true;
        }

        async restoreSessionState() {
            try {
                const raw = localStorage.getItem(this.storageKey);
                if (!raw) return;

                const data = JSON.parse(raw);
                if (!data || !Array.isArray(data.jobs)) return;

                this.sessionSectionsInitialized = false;

                const allJobs = data.jobs || [];

                const validJobs = [];
                const validIds = new Set();

                for (const job of allJobs) {
                if (!this.shouldPersistJob(job)) continue;

                const status = this.normalizeStatus(job.status);

                if (status === 'completed') {
                    let keep = true;

                    if (Array.isArray(job.resultPath)) {
                        keep = await this.prunePlaylistOutputs(job);
                    } else {
                        const hasOutput = await this.jobHasExistingOutput(job);
                        keep = hasOutput;
                    }
                    if (!keep) {
                        continue;
                    }
                }

                validJobs.push(job);
                validIds.add(job.id);
            }
                this.batches.clear();
                this.jobToBatch.clear();
                this.jobStates.clear();

                (data.batches || []).forEach(b => {
                    const jobIds = (b.jobs || []).filter(id => validIds.has(id));
                    if (!jobIds.length) return;

                    const batch = this.ensureBatch(b.id, b.total, b.meta || {});
                    jobIds.forEach(jobId => {
                        batch.jobs.add(jobId);
                        this.jobToBatch.set(jobId, b.id);
                    });
                });

                for (const job of validJobs) {
                    this.jobStates.set(job.id, job);
                    const batchId = data.jobToBatch?.[job.id] || null;

                    this.updateJobUI(job, batchId);

                    const s = this.normalizeStatus(job.status);
                    if (!['completed', 'error', 'canceled'].includes(s)) {
                        this.trackJob(job.id, batchId);
                    }
                }

                this.saveSessionState();
            } catch (e) {
                console.warn('[JobManager] restoreSessionState error:', e);
                try { localStorage.removeItem(this.storageKey); } catch (_) {}
            }
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
            this.saveSessionState();
        } catch (error) {
            console.error("Job gönderme hatası:", error);
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error.message}`, 'error', 'error');
        }
    }
}

export const jobsPanelManager = new JobsPanelManager();

if (typeof window !== 'undefined') {
    window.jobsPanelManager = jobsPanelManager;
}
