import {
    MUSIC_TEXT_QUEUE_STORAGE_KEY,
    parseMusicTextList,
    matchMusicTextItems,
    buildMusicTextJobPayload,
    loadMusicTextQueue,
    loadMusicTextQueueState,
    saveMusicTextQueueState,
    applyMusicTextMatchProgress,
    reconcileMusicTextQueuedItems,
    resetMusicTextJob,
    pruneMusicTextTerminalItems,
    MUSIC_TEXT_DONE_PROGRESS_TTL_MS,
    shouldShowMusicTextOperationProgress
} from './MusicTextImport.js';

export class MusicUrlQueueManager {
    constructor(app) {
        this.app = app;
        this.items = [];
        this.running = false;
        this.autoRemoveSuccessful = false;
        this.textAutoRemoveTerminal = false;
        this.nextId = 1;
        this.modalEl = null;
        this.listEl = null;
        this.countEl = null;
        this.addBtn = null;
        this.modalInput = null;
        this.modalAddBtn = null;
        this.modalSupportEl = null;
        this.autoRemoveCheckbox = null;
        this.queueStartBtn = null;
        this.textItems = [];
        this.textNextId = 1;
        this.activeTab = 'urls';
        this.textInput = null;
        this.textAddBtn = null;
        this.textProgress = null;
        this.textOperation = null;
        this.textResumePromise = null;
        this.storageKey = 'gharmonize_music_url_queue_v2';
        this.legacyStorageKey = 'gharmonize_music_url_queue_v1';
        this.textReconcileInFlight = false;
        this.textProgressHideTimer = null;
    }

    initialize() {
        this.addBtn = document.getElementById('musicUrlQueueAddBtn');
        this.countEl = document.getElementById('musicUrlQueueCount');
        if (!this.addBtn) return;

        this.restoreState();
        this.createModal();
        void this.resumeTextMatchOperation();
        this.addBtn.addEventListener('click', () => this.addCurrentUrlAndOpen());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.isOpen()) this.close();
        });
        document.addEventListener('i18n:applied', () => {
            this.updateButton();
            this.render();
        });
        window.addEventListener('storage', (event) => {
            if (event.key !== MUSIC_TEXT_QUEUE_STORAGE_KEY || this.running) return;
            this.syncTextItemsFromShared();
        });
        document.addEventListener('job:terminal', (event) => {
            const jobId = event?.detail?.jobId || event?.detail?.job?.id;
            const status = event?.detail?.status || event?.detail?.job?.status;
            this.applyTextJobTerminal(jobId, status);
        });
        this.updateButton();
        this.resolveMissingTitles();
    }

    restoreState() {
        try {
            if (typeof localStorage === 'undefined') return;
            const textState = loadMusicTextQueueState();
            this.textItems = textState.items;
            this.textOperation = textState.operation;
            this.textAutoRemoveTerminal = textState.preferences?.autoRemoveTerminal === true;
            if (this.textAutoRemoveTerminal && !['matching', 'queueing'].includes(this.textOperation?.phase)) {
                this.textItems = pruneMusicTextTerminalItems(this.textItems, { autoRemoveTerminal: true });
            }
            this.textProgress = this.progressFromTextOperation(this.textOperation);
            const raw = localStorage.getItem(this.storageKey) || localStorage.getItem(this.legacyStorageKey);
            const saved = raw ? JSON.parse(raw) : {};
            const rows = Array.isArray(saved?.items) ? saved.items : [];
            const allowedStatuses = new Set(['pending', 'running', 'completed', 'error', 'canceled']);

            this.items = rows
                .map((entry, index) => {
                    const url = String(entry?.url || '').trim();
                    if (!url) return null;
                    const savedStatus = allowedStatuses.has(entry?.status) ? entry.status : 'pending';
                    const status = savedStatus === 'running' ? 'pending' : savedStatus;
                    const title = String(entry?.title || '').trim();
                    return {
                        id: Number.isFinite(Number(entry?.id)) ? Number(entry.id) : index + 1,
                        url,
                        status,
                        error: savedStatus === 'running' ? null : (entry?.error ? String(entry.error) : null),
                        jobId: null,
                        title,
                        titleStatus: title ? 'resolved' : 'idle'
                    };
                })
                .filter(Boolean);

            const maxId = this.items.reduce((max, item) => Math.max(max, item.id), 0);
            const maxTextId = this.textItems.reduce((max, item) => Math.max(max, item.id), 0);
            this.nextId = Math.max(maxId + 1, 1);
            this.textNextId = Math.max(maxTextId + 1, 1);
            this.autoRemoveSuccessful = saved?.autoRemoveSuccessful === true;
            this.persistState();
        } catch (error) {
            console.warn('Music URL queue state could not be restored:', error);
        }
    }

    persistState() {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(this.storageKey, JSON.stringify({
                version: 2,
                autoRemoveSuccessful: this.autoRemoveSuccessful,
                items: this.items.map((item) => ({
                    id: item.id,
                    url: item.url,
                    status: item.status,
                    error: item.error || null,
                    title: item.title || ''
                })),
                textItems: this.textItems.map((item) => ({
                    id: item.id,
                    artist: item.artist || '',
                    title: item.title || '',
                    query: item.query || '',
                    status: item.status,
                    error: item.error || null,
                    match: item.match || null,
                    jobId: item.jobId || null
                }))
            }));
            saveMusicTextQueueState({
                items: this.textItems,
                operation: this.textOperation,
                preferences: { autoRemoveTerminal: this.textAutoRemoveTerminal }
            });
        } catch (error) {
            console.warn('Music URL queue state could not be saved:', error);
        }
    }

    createModal() {
        // The modal is generated by this manager. Recreate it on initialization so a
        // stale manager instance can never leave old click handlers attached to the
        // shared primary button (for example after an in-page reinitialization).
        document.getElementById('musicUrlQueueModal')?.remove();

        const backdrop = document.createElement('div');
        backdrop.id = 'musicUrlQueueModal';
        backdrop.className = 'music-url-queue-backdrop';
        backdrop.setAttribute('aria-hidden', 'true');
        backdrop.innerHTML = `
            <section class="music-url-queue-dialog" role="dialog" aria-modal="true" aria-labelledby="musicUrlQueueTitle">
                <header class="music-url-queue-header">
                    <div>
                        <h3 id="musicUrlQueueTitle"></h3>
                        <p id="musicUrlQueueHint" class="muted"></p>
                    </div>
                    <button type="button" id="musicUrlQueueClose" class="music-url-queue-close" aria-label="Close">×</button>
                </header>
                <div class="music-url-queue-tabs" role="tablist">
                    <button type="button" class="music-url-queue-tab is-active" data-music-queue-tab="urls" role="tab" aria-selected="true"></button>
                    <button type="button" class="music-url-queue-tab" data-music-queue-tab="text" role="tab" aria-selected="false"></button>
                </div>
                <div class="music-url-queue-pane is-active" data-music-queue-pane="urls">
                    <div class="music-url-queue-entry">
                        <div class="music-url-queue-entry-field">
                            <input type="url" id="musicUrlQueueInput" class="form-control music-url-queue-entry-input" autocomplete="off" spellcheck="false" />
                            <span id="musicUrlQueueInputSupport" class="music-url-queue-support is-empty" aria-live="polite"></span>
                        </div>
                        <button type="button" id="musicUrlQueueModalAdd" class="btn-secondary music-url-queue-entry-add"></button>
                    </div>
                    <div class="music-url-queue-summary"><span id="musicUrlQueueSummary"></span></div>
                    <div id="musicUrlQueueList" class="music-url-queue-list"></div>
                </div>
                <div class="music-url-queue-pane" data-music-queue-pane="text">
                    <div class="music-text-import-editor">
                        <div class="music-text-import-format">
                            <strong id="musicTextImportFormatTitle"></strong>
                            <code>Sanatçı – Şarkı</code>
                            <span id="musicTextImportFormatHint"></span>
                        </div>
                        <textarea id="musicTextImportInput" rows="7" spellcheck="false"></textarea>
                        <div class="music-text-import-editor-actions">
                            <span id="musicTextImportParseHint" class="muted"></span>
                            <button type="button" id="musicTextImportAdd" class="btn-secondary"></button>
                        </div>
                    </div>
                    <div class="music-url-queue-summary"><span id="musicTextImportSummary"></span></div>
                    <div id="musicTextImportProgress" class="music-text-import-progress" aria-live="polite" hidden></div>
                    <div id="musicTextImportList" class="music-url-queue-list music-text-import-list"></div>
                </div>
                <footer class="music-url-queue-footer">
                    <label class="music-url-queue-auto-remove" for="musicUrlQueueAutoRemove">
                        <input type="checkbox" id="musicUrlQueueAutoRemove" />
                        <span id="musicUrlQueueAutoRemoveLabel"></span>
                    </label>
                    <div class="music-url-queue-footer-actions">
                        <button type="button" id="musicUrlQueueDone" class="btn-secondary"></button>
                        <button type="button" id="musicUrlQueueStart" class="btn-primary"></button>
                    </div>
                </footer>
            </section>
        `;

        document.body.appendChild(backdrop);
        this.modalEl = backdrop;
        this.listEl = backdrop.querySelector('#musicUrlQueueList');
        this.modalInput = backdrop.querySelector('#musicUrlQueueInput');
        this.modalAddBtn = backdrop.querySelector('#musicUrlQueueModalAdd');
        this.modalSupportEl = backdrop.querySelector('#musicUrlQueueInputSupport');
        this.autoRemoveCheckbox = backdrop.querySelector('#musicUrlQueueAutoRemove');
        this.queueStartBtn = backdrop.querySelector('#musicUrlQueueStart');
        this.textInput = backdrop.querySelector('#musicTextImportInput');
        this.textAddBtn = backdrop.querySelector('#musicTextImportAdd');

        backdrop.querySelector('#musicUrlQueueClose')?.addEventListener('click', () => this.close());
        backdrop.querySelector('#musicUrlQueueDone')?.addEventListener('click', () => this.close());
        this.queueStartBtn?.addEventListener('click', (event) => {
            event.preventDefault();
            void this.handlePrimaryAction();
        });
        this.textAddBtn?.addEventListener('click', () => this.addTextInput());
        backdrop.querySelectorAll('[data-music-queue-tab]').forEach((button) => {
            button.addEventListener('click', () => this.setActiveTab(button.dataset.musicQueueTab || 'urls'));
        });
        backdrop.addEventListener('click', (event) => {
            if (event.target === backdrop) this.close();
        });
        this.autoRemoveCheckbox?.addEventListener('change', (event) => {
            const checked = !!event.target.checked;
            const textPane = this.modalEl?.querySelector('[data-music-queue-pane="text"]');
            const textIsActive = !!textPane?.classList?.contains('is-active');
            if (textIsActive) {
                this.textAutoRemoveTerminal = checked;
                if (checked && !['matching', 'queueing'].includes(this.textOperation?.phase)) {
                    this.textItems = pruneMusicTextTerminalItems(this.textItems, { autoRemoveTerminal: true });
                }
            } else {
                this.autoRemoveSuccessful = checked;
            }
            this.persistState();
            this.render();
        });
        this.modalInput?.addEventListener('input', () => this.updateModalInputSupport());
        this.modalInput?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            this.addModalUrl();
        });
        this.modalAddBtn?.addEventListener('click', () => this.addModalUrl());
        this.listEl?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-queue-remove-id]');
            if (!button) return;
            const id = Number(button.dataset.queueRemoveId);
            this.remove(id);
        });
        backdrop.querySelector('#musicTextImportList')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-text-queue-remove-id]');
            if (!button) return;
            this.removeTextItem(Number(button.dataset.textQueueRemoveId));
        });

        this.render();
    }

    isOpen() {
        return this.modalEl?.classList.contains('is-open') || false;
    }

    open() {
        if (!this.modalEl) return;
        if (!this.running) this.syncTextItemsFromShared();
        void this.resumeTextMatchOperation();
        void this.reconcileTextQueuedJobs();
        this.render();
        this.modalEl.classList.add('is-open');
        this.modalEl.setAttribute('aria-hidden', 'false');
        if (this.activeTab === 'text') this.textInput?.focus();
        else this.modalInput?.focus();
    }

    close() {
        if (!this.modalEl) return;
        this.modalEl.classList.remove('is-open');
        this.modalEl.setAttribute('aria-hidden', 'true');
        this.addBtn?.focus();
    }

    progressFromTextOperation(operation = null) {
        if (!operation || !shouldShowMusicTextOperationProgress(operation)) return null;
        return {
            phase: operation.phase || 'matching',
            total: Number(operation.total || 0),
            completed: Number(operation.completed || 0),
            matched: Number(operation.matched || 0),
            failed: Number(operation.failed || 0),
            message: operation.message || null,
            updatedAt: Number(operation.updatedAt || Date.now())
        };
    }

    clearTextProgressHideTimer() {
        if (this.textProgressHideTimer === null) return;
        clearTimeout(this.textProgressHideTimer);
        this.textProgressHideTimer = null;
    }

    scheduleTextProgressHide(state) {
        this.clearTextProgressHideTimer();
        if (!state || state.phase !== 'done') return;
        const elapsed = Math.max(0, Date.now() - Number(state.updatedAt || Date.now()));
        const remaining = MUSIC_TEXT_DONE_PROGRESS_TTL_MS - elapsed;
        if (remaining <= 0) {
            this.textProgress = null;
            return;
        }
        this.textProgressHideTimer = setTimeout(() => {
            this.textProgressHideTimer = null;
            if (this.textProgress?.phase !== 'done') return;
            this.textProgress = null;
            this.renderTextProgress();
        }, remaining + 20);
    }

    syncTextItemsFromShared() {
        if (this.running) return;
        const shared = loadMusicTextQueueState();
        this.textItems = shared.items;
        this.textOperation = shared.operation;
        this.textAutoRemoveTerminal = shared.preferences?.autoRemoveTerminal === true;
        if (this.textAutoRemoveTerminal && !['matching', 'queueing'].includes(this.textOperation?.phase)) {
            const before = this.textItems.length;
            this.textItems = pruneMusicTextTerminalItems(this.textItems, { autoRemoveTerminal: true });
            if (this.textItems.length !== before) {
                saveMusicTextQueueState({
                    items: this.textItems,
                    operation: this.textOperation,
                    preferences: { autoRemoveTerminal: true }
                });
            }
        }
        this.textProgress = this.progressFromTextOperation(this.textOperation);
        this.textNextId = Math.max(1, ...this.textItems.map((item) => Number(item.id) + 1 || 1));
        this.updateButton();
        this.render();
        if (this.textOperation?.phase === 'matching') void this.resumeTextMatchOperation();
    }

    async reconcileTextQueuedJobs() {
        if (this.textReconcileInFlight) return;
        if (!this.textItems.some((item) => item.status === 'queued' && item.jobId)) return;
        this.textReconcileInFlight = true;
        try {
            const result = await reconcileMusicTextQueuedItems(this.textItems);
            if (!result.changed) return;
            this.textItems = pruneMusicTextTerminalItems(result.items, { autoRemoveTerminal: this.textAutoRemoveTerminal });
            this.textNextId = Math.max(1, ...this.textItems.map((item) => Number(item.id) + 1 || 1));
            this.textProgress = null;
            this.updateAfterMutation();
        } finally {
            this.textReconcileInFlight = false;
        this.textProgressHideTimer = null;
        }
    }

    applyTextJobTerminal(jobId, status) {
        const result = resetMusicTextJob(this.textItems, jobId, status);
        if (!result.changed) return;
        this.textItems = pruneMusicTextTerminalItems(result.items, { autoRemoveTerminal: this.textAutoRemoveTerminal });
        this.textProgress = null;
        this.updateAfterMutation();
    }

    handlePrimaryAction() {
        // Resolve the action from the pane that is actually visible in the DOM. This
        // keeps the single footer button correct even if state was restored or the UI
        // was re-rendered between tab selection and click.
        const textPane = this.modalEl?.querySelector('[data-music-queue-pane="text"]');
        const textIsActive = !!textPane?.classList?.contains('is-active');
        this.activeTab = textIsActive ? 'text' : 'urls';
        return this.activeTab === 'text' ? this.startTextQueue() : this.startQueue();
    }

    setActiveTab(tab = 'urls') {
        this.activeTab = tab === 'text' ? 'text' : 'urls';
        if (!this.modalEl) return;
        this.modalEl.querySelectorAll('[data-music-queue-tab]').forEach((button) => {
            const active = button.dataset.musicQueueTab === this.activeTab;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        this.modalEl.querySelectorAll('[data-music-queue-pane]').forEach((pane) => {
            pane.classList.toggle('is-active', pane.dataset.musicQueuePane === this.activeTab);
        });
        const autoRemove = this.modalEl.querySelector('.music-url-queue-auto-remove');
        if (autoRemove) autoRemove.hidden = false;
        this.render();
        if (this.isOpen()) {
            if (this.activeTab === 'text') this.textInput?.focus();
            else this.modalInput?.focus();
        }
    }

    addTextInput() {
        this.textItems = loadMusicTextQueue();
        this.textNextId = Math.max(1, ...this.textItems.map((item) => Number(item.id) + 1 || 1));
        const parsed = parseMusicTextList(this.textInput?.value || '');
        if (!parsed.length) {
            this.app.showNotification(this.app.t('musicQueue.textNoItems'), 'info', 'default');
            return false;
        }
        const existing = new Set(this.textItems.map((item) => String(item.query || '').toLocaleLowerCase()));
        let added = 0;
        for (const entry of parsed) {
            const key = String(entry.query || '').toLocaleLowerCase();
            if (!key || existing.has(key)) continue;
            existing.add(key);
            this.textItems.push({
                id: this.textNextId++,
                artist: entry.artist,
                title: entry.title,
                query: entry.query,
                status: 'pending',
                error: null,
                match: null,
                jobId: null
            });
            added += 1;
        }
        if (added && this.textInput) this.textInput.value = '';
        if (added) {
            this.textProgress = null;
            this.textOperation = null;
        }
        this.updateAfterMutation();
        this.app.showNotification(this.app.t('musicQueue.textAdded', { count: added }), added ? 'success' : 'info', 'default');
        return added > 0;
    }

    removeTextItem(id) {
        const item = this.textItems.find((entry) => entry.id === id);
        if (!item || item.status === 'running') return false;
        this.textItems = this.textItems.filter((entry) => entry.id !== id);
        if (this.textOperation?.phase !== 'matching') {
            this.textOperation = null;
            this.textProgress = null;
        }
        this.updateAfterMutation();
        return true;
    }

    hasRunnableTextItems() {
        return this.textItems.some((item) => ['pending', 'error', 'not-found', 'matched'].includes(item.status));
    }

    getTextMatchConcurrency() {
        const value = Number(document.getElementById('spotifyConcurrencyInput')?.value || document.getElementById('youtubeConcurrencyInput')?.value || 3);
        return Math.max(1, Math.min(8, Number.isFinite(value) ? Math.round(value) : 3));
    }

    getClassicTextOutputPayload() {
        const outputSettings = this.app.resolveCurrentOutputSettings();
        return {
            format: outputSettings.format,
            bitrate: outputSettings.bitrate,
            sampleRate: Number(outputSettings.sampleRate || 48000),
            includeLyrics: !!document.getElementById('lyricsCheckbox')?.checked,
            embedLyrics: !!document.getElementById('embedLyricsCheckbox')?.checked,
            volumeGain: this.app.currentVolumeGain || 1.0,
            autoCreateZip: this.app.autoCreateZip,
            youtubeConcurrency: Number(document.getElementById('youtubeConcurrencyInput')?.value || 4),
            spotifyConcurrency: Number(document.getElementById('spotifyConcurrencyInput')?.value || 4),
            ringtone: outputSettings.ringtone
        };
    }

    applyTextMatchOperationProgress(serverOperation, seed = {}) {
        const previous = this.textOperation || {};
        const itemIds = Array.isArray(seed.itemIds) && seed.itemIds.length
            ? seed.itemIds.map(String)
            : (Array.isArray(serverOperation?.itemIds) && serverOperation.itemIds.length
                ? serverOperation.itemIds.map(String)
                : (previous.itemIds || []).map(String));
        const queueItemIds = Array.isArray(seed.queueItemIds) && seed.queueItemIds.length
            ? seed.queueItemIds.map(String)
            : (previous.queueItemIds || itemIds).map(String);
        const baseMatched = Number(seed.baseMatched ?? previous.baseMatched ?? 0);
        const outputPayload = seed.outputPayload || previous.outputPayload || null;
        const playlistTitle = seed.playlistTitle || previous.playlistTitle || this.app.t('musicQueue.textPlaylistTitle');

        const operationForRows = { ...(serverOperation || {}), itemIds };
        this.textItems = applyMusicTextMatchProgress(this.textItems, operationForRows);

        const serverMatched = Number(serverOperation?.matched || 0);
        const serverFailed = Number(serverOperation?.failed || 0);
        const serverCompleted = Number(serverOperation?.completed || 0);
        this.textOperation = {
            id: String(serverOperation?.id || previous.id || ''),
            phase: 'matching',
            itemIds,
            queueItemIds,
            baseMatched,
            total: queueItemIds.length || (baseMatched + Number(serverOperation?.total || itemIds.length)),
            completed: Math.min(queueItemIds.length || Number.MAX_SAFE_INTEGER, baseMatched + serverCompleted),
            matched: baseMatched + serverMatched,
            failed: serverFailed,
            outputPayload,
            playlistTitle,
            updatedAt: Date.now()
        };
        this.textProgress = this.progressFromTextOperation(this.textOperation);
        this.updateAfterMutation();
    }

    async queueResolvedTextOperation() {
        const operation = this.textOperation;
        if (!operation) return null;
        const queueIds = new Set((operation.queueItemIds?.length ? operation.queueItemIds : operation.itemIds || []).map(String));
        const queueItems = this.textItems.filter((item) => queueIds.has(String(item.id)));
        const matchedEntries = queueItems
            .filter((item) => item.status === 'matched' && item.match?.id)
            .map((item) => ({
                id: item.id,
                artist: item.artist,
                title: item.title,
                query: item.query,
                matched: true,
                match: item.match
            }));
        const failed = queueItems.filter((item) => ['not-found', 'error'].includes(item.status)).length;

        this.textOperation = {
            ...operation,
            phase: matchedEntries.length ? 'queueing' : 'done',
            total: queueItems.length,
            completed: queueItems.length,
            matched: matchedEntries.length,
            failed,
            updatedAt: Date.now()
        };
        this.textProgress = this.progressFromTextOperation(this.textOperation);

        if (!matchedEntries.length) {
            if (this.textAutoRemoveTerminal) {
                this.textItems = pruneMusicTextTerminalItems(this.textItems, { autoRemoveTerminal: true });
            }
            this.updateAfterMutation();
            this.app.showNotification(this.app.t('musicQueue.textMatchNone'), 'warning', 'default');
            return { matched: 0, failed };
        }
        this.updateAfterMutation();

        const payload = buildMusicTextJobPayload(
            matchedEntries,
            operation.outputPayload || this.getClassicTextOutputPayload(),
            { title: operation.playlistTitle || this.app.t('musicQueue.textPlaylistTitle') }
        );
        const job = payload ? await this.app.jobManager.submitJob(payload) : null;
        if (!job?.id) throw new Error(this.app.t('musicQueue.textQueueFailed'));

        const matchedIds = new Set(matchedEntries.map((entry) => String(entry.id)));
        for (const item of this.textItems) {
            if (!matchedIds.has(String(item.id))) continue;
            item.status = 'queued';
            item.jobId = job.id;
            item.error = null;
        }
        this.textOperation = {
            ...this.textOperation,
            phase: 'done',
            matched: matchedEntries.length,
            failed,
            updatedAt: Date.now()
        };
        this.textProgress = this.progressFromTextOperation(this.textOperation);
        if (this.textAutoRemoveTerminal) {
            this.textItems = pruneMusicTextTerminalItems(this.textItems, { autoRemoveTerminal: true });
        }
        this.updateAfterMutation();
        this.app.showNotification(
            this.app.t('musicQueue.textQueued', { matched: matchedEntries.length, failed }),
            failed === 0 ? 'success' : 'warning',
            'queue'
        );
        return { matched: matchedEntries.length, failed, jobId: job.id };
    }

    async resumeTextMatchOperation() {
        if (this.textResumePromise) return this.textResumePromise;
        const state = loadMusicTextQueueState();
        const operation = state.operation;
        if (!operation || operation.phase !== 'matching' || !operation.id) return null;

        this.textItems = state.items;
        this.textOperation = operation;
        this.textProgress = this.progressFromTextOperation(operation);
        const matchIds = new Set((operation.itemIds || []).map(String));
        const matchItems = this.textItems.filter((item) => matchIds.has(String(item.id)));
        if (!matchItems.length) return null;

        this.running = true;
        this.updateButton();
        this.render();
        this.textResumePromise = (async () => {
            try {
                await matchMusicTextItems(matchItems, {
                    operationId: operation.id,
                    concurrency: this.getTextMatchConcurrency(),
                    onProgress: (progress) => this.applyTextMatchOperationProgress(progress)
                });
                return await this.queueResolvedTextOperation();
            } catch (error) {
                for (const item of this.textItems) {
                    if (item.status === 'running') {
                        item.status = item.match?.id ? 'matched' : 'error';
                        item.error = item.match?.id ? null : (error?.message || String(error));
                    }
                }
                this.textOperation = {
                    ...this.textOperation,
                    phase: 'error',
                    message: error?.message || String(error),
                    updatedAt: Date.now()
                };
                this.textProgress = this.progressFromTextOperation(this.textOperation);
                this.updateAfterMutation();
                return null;
            } finally {
                this.running = false;
                this.textResumePromise = null;
                this.updateAfterMutation();
            }
        })();
        return this.textResumePromise;
    }

    async startTextQueue() {
        if (this.running) return null;
        const state = loadMusicTextQueueState();
        this.textItems = state.items;
        this.textOperation = state.operation;
        if (this.textOperation?.phase === 'matching' && this.textOperation?.id) {
            return this.resumeTextMatchOperation();
        }

        const runnable = this.textItems.filter((item) => ['pending', 'error', 'not-found', 'matched'].includes(item.status));
        if (!runnable.length) return null;

        const reusable = runnable.filter((item) => item.status === 'matched' && item.match?.id);
        const needsMatch = runnable.filter((item) => !(item.status === 'matched' && item.match?.id));
        const outputPayload = this.getClassicTextOutputPayload();
        const playlistTitle = this.app.t('musicQueue.textPlaylistTitle');

        // If every runnable row already has a safe match (for example after a
        // canceled download job), skip YouTube search entirely and create the
        // new playlist-like job from the retained matches.
        if (!needsMatch.length) {
            this.running = true;
            this.textOperation = {
                id: '',
                phase: 'queueing',
                itemIds: [],
                queueItemIds: runnable.map((item) => String(item.id)),
                baseMatched: reusable.length,
                total: runnable.length,
                completed: runnable.length,
                matched: reusable.length,
                failed: 0,
                outputPayload,
                playlistTitle,
                updatedAt: Date.now()
            };
            this.textProgress = this.progressFromTextOperation(this.textOperation);
            this.updateAfterMutation();
            try {
                return await this.queueResolvedTextOperation();
            } catch (error) {
                this.textOperation = { ...this.textOperation, phase: 'error', message: error?.message || String(error), updatedAt: Date.now() };
                this.textProgress = this.progressFromTextOperation(this.textOperation);
                this.updateAfterMutation();
                this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error?.message || error}`, 'error', 'error');
                return null;
            } finally {
                this.running = false;
                this.updateAfterMutation();
            }
        }

        this.running = true;
        this.textProgress = { phase: 'matching', total: runnable.length, completed: reusable.length, matched: reusable.length, failed: 0 };
        this.updateButton();
        this.render();

        try {
            const result = await matchMusicTextItems(needsMatch, {
                concurrency: this.getTextMatchConcurrency(),
                onOperation: (serverOperation) => {
                    this.applyTextMatchOperationProgress(serverOperation, {
                        itemIds: needsMatch.map((item) => String(item.id)),
                        queueItemIds: runnable.map((item) => String(item.id)),
                        baseMatched: reusable.length,
                        outputPayload,
                        playlistTitle
                    });
                },
                onProgress: (progress) => this.applyTextMatchOperationProgress(progress, {
                    itemIds: needsMatch.map((item) => String(item.id)),
                    queueItemIds: runnable.map((item) => String(item.id)),
                    baseMatched: reusable.length,
                    outputPayload,
                    playlistTitle
                })
            });

            // Ensure the final server snapshot is applied even if the last poll
            // completed between UI paints.
            this.applyTextMatchOperationProgress(result.operation || {
                id: result.operationId,
                status: 'completed',
                items: result.items,
                total: needsMatch.length,
                completed: needsMatch.length,
                matched: result.matched,
                failed: result.failed,
                itemIds: needsMatch.map((item) => String(item.id))
            }, {
                itemIds: needsMatch.map((item) => String(item.id)),
                queueItemIds: runnable.map((item) => String(item.id)),
                baseMatched: reusable.length,
                outputPayload,
                playlistTitle
            });
            return await this.queueResolvedTextOperation();
        } catch (error) {
            for (const item of runnable) {
                if (item.status === 'running') {
                    item.status = item.match?.id ? 'matched' : 'error';
                    item.error = item.match?.id ? null : (error?.message || String(error));
                }
            }
            this.textOperation = {
                ...(this.textOperation || {}),
                phase: 'error',
                total: runnable.length,
                matched: runnable.filter((item) => item.status === 'matched').length,
                failed: runnable.filter((item) => ['error', 'not-found'].includes(item.status)).length,
                message: error?.message || String(error),
                updatedAt: Date.now()
            };
            this.textProgress = this.progressFromTextOperation(this.textOperation);
            this.updateAfterMutation();
            this.app.showNotification(`${this.app.t('notif.errorPrefix')}: ${error?.message || error}`, 'error', 'error');
            return null;
        } finally {
            this.running = false;
            this.updateAfterMutation();
        }
    }

    addCurrentUrlAndOpen() {
        const input = document.getElementById('urlInput');
        const url = input?.value.trim() || '';

        if (url && this.app.isSpotifyUrl(url)) {
            const added = this.add(url);
            if (added && input) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }

        this.open();
    }

    addModalUrl() {
        const url = this.modalInput?.value.trim() || '';
        if (!url) {
            this.updateModalInputSupport();
            return false;
        }

        const added = this.add(url);
        if (added && this.modalInput) {
            this.modalInput.value = '';
            this.updateModalInputSupport();
            this.modalInput.focus();
        }
        return added;
    }

    add(url) {
        const normalized = String(url || '').trim();
        if (!normalized) return false;

        if (this.items.some((item) => item.url === normalized)) {
            this.app.showNotification(
                this.app.t('musicQueue.duplicate') || 'This URL is already in the list.',
                'info',
                'default'
            );
            this.updateButton();
            return false;
        }

        const item = {
            id: this.nextId++,
            url: normalized,
            status: 'pending',
            error: null,
            jobId: null,
            title: '',
            titleStatus: 'idle'
        };
        this.items.push(item);
        this.updateAfterMutation();
        this.resolveItemTitle(item.id);
        return true;
    }

    remove(id) {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.status === 'running') return false;
        this.items = this.items.filter((entry) => entry.id !== id);
        this.updateAfterMutation();
        return true;
    }

    hasItems() {
        return this.items.length > 0;
    }

    hasRunnableItems() {
        return this.items.some((item) => ['pending', 'error', 'canceled'].includes(item.status));
    }

    getRepresentativeUrl() {
        return this.items.find((item) => ['pending', 'error', 'canceled'].includes(item.status))?.url
            || this.items[0]?.url
            || '';
    }

    resolveMissingTitles() {
        for (const item of this.items) {
            if (!item.title && this.isSupportedUrl(item.url)) {
                this.resolveItemTitle(item.id);
            }
        }
    }

    async resolveItemTitle(id) {
        const item = this.items.find((entry) => entry.id === id);
        if (!item || item.title || !this.isSupportedUrl(item.url)) return null;
        if (item.titleStatus === 'loading') return null;

        item.titleStatus = 'loading';
        this.render();

        try {
            const response = await fetch('/api/spotify/url-title', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: item.url })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data?.ok === false) {
                throw new Error(data?.error?.message || `HTTP ${response.status}`);
            }

            const liveItem = this.items.find((entry) => entry.id === id);
            if (!liveItem) return null;
            liveItem.title = String(data?.title || '').trim();
            liveItem.titleStatus = liveItem.title ? 'resolved' : 'error';
            this.persistState();
            this.render();
            return liveItem.title || null;
        } catch {
            const liveItem = this.items.find((entry) => entry.id === id);
            if (!liveItem) return null;
            liveItem.titleStatus = 'error';
            this.persistState();
            this.render();
            return null;
        }
    }

    getProvider(url) {
        const raw = String(url || '').trim();
        const value = raw.toLowerCase();

        if (value.startsWith('spotify:')) return 'Spotify';
        if (value.startsWith('deezer:')) return 'Deezer';

        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            return this.app.t('musicQueue.unknownProvider');
        }

        if (!/^https?:$/i.test(parsed.protocol)) {
            return this.app.t('musicQueue.unknownProvider');
        }

        const host = parsed.hostname.toLowerCase();
        if (host === 'open.spotify.com') return 'Spotify';
        if (host === 'music.apple.com' || host === 'embed.music.apple.com') return 'Apple Music';
        if (host === 'tidal.com' || host === 'www.tidal.com' || host === 'listen.tidal.com') return 'TIDAL';
        if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'SoundCloud';
        if (
            host === 'deezer.com'
            || host.endsWith('.deezer.com')
            || host === 'deezer.page.link'
            || host.endsWith('.deezer.page.link')
        ) {
            return 'Deezer';
        }

        return this.app.t('musicQueue.unknownProvider');
    }

    getStatusLabel(status) {
        const key = {
            pending: 'musicQueue.status.pending',
            running: 'musicQueue.status.running',
            completed: 'musicQueue.status.completed',
            error: 'musicQueue.status.error',
            canceled: 'musicQueue.status.canceled'
        }[status] || 'musicQueue.status.pending';
        return this.app.t(key);
    }

    isSupportedUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return false;

        if (/^spotify:(track|playlist|album):[A-Za-z0-9]+$/i.test(raw)) return true;
        if (/^deezer:(track|album|playlist|artist):\d+$/i.test(raw)) return true;

        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            return false;
        }

        if (!/^https?:$/i.test(parsed.protocol)) return false;
        const host = parsed.hostname.toLowerCase();
        const parts = parsed.pathname.split('/').filter(Boolean);

        if (host === 'open.spotify.com') {
            const spotifyParts = /^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '')
                ? parts.slice(1)
                : parts;
            return ['track', 'playlist', 'album'].includes(String(spotifyParts[0] || '').toLowerCase())
                && /^[A-Za-z0-9]+$/.test(String(spotifyParts[1] || ''));
        }

        if (host === 'music.apple.com' || host === 'embed.music.apple.com') {
            const type = String(parts[1] || '').toLowerCase();
            const lastPart = String(parts[parts.length - 1] || '');
            const queryTrackId = String(parsed.searchParams.get('i') || '');
            if (type === 'song' || /^\d+$/.test(queryTrackId)) {
                return /^\d+$/.test(queryTrackId) || /^\d+$/.test(lastPart);
            }
            if (type === 'album') return /^\d+$/.test(lastPart);
            if (type === 'playlist') return !!lastPart;
            return false;
        }

        if (host === 'tidal.com' || host === 'www.tidal.com' || host === 'listen.tidal.com') {
            const type = String(parts[0] || '').toLowerCase();
            if (type === 'playlist') return /^[0-9a-f-]{16,64}$/i.test(String(parts[1] || ''));
            if (type === 'album') {
                if (!/^\d+$/.test(String(parts[1] || ''))) return false;
                if (String(parts[2] || '').toLowerCase() === 'track') return /^\d+$/.test(String(parts[3] || ''));
                return parts.length >= 2;
            }
            return false;
        }

        if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
            const first = String(parts[0] || '').toLowerCase();
            const second = String(parts[1] || '').toLowerCase();
            if (!first) return false;
            if (first === 'discover') return second === 'sets' && !!parts[2];
            if (first === 'buzzing-playlists') return second === 'sets' && !!parts[2];
            if (first === 'stations') return second === 'track' && !!parts[2];
            if (['discover', 'charts', 'buzzing-playlists', 'stations'].includes(first)) return false;
            if (second === 'sets') return !!parts[2] || parts.length === 2;
            if (['tracks', 'likes', 'reposts', 'sets', 'albums', 'popular-tracks', 'spotlight'].includes(second)) return true;
            return parts.length >= 1;
        }

        if (host === 'link.deezer.com' || host === 'deezer.page.link' || host.endsWith('.deezer.page.link')) {
            return true;
        }

        if (host === 'deezer.com' || host.endsWith('.deezer.com')) {
            const first = String(parts[0] || '').toLowerCase();
            const second = String(parts[1] || '').toLowerCase();
            const localePattern = /^[a-z]{2}(?:-[a-z]{2})?$/i;
            const offset = localePattern.test(first) ? 1 : 0;
            const type = String(parts[offset] || '').toLowerCase();

            if (type === 'search') {
                return !!parts[offset + 1]
                    && String(parts[offset + 2] || '').toLowerCase() === 'track'
                    && parts.length === offset + 3;
            }
            if (type === 'smarttracklist') {
                return /^inspired-by-\d+$/i.test(String(parts[offset + 1] || ''))
                    && parts.length === offset + 2;
            }
            return ['track', 'album', 'playlist', 'artist'].includes(type)
                && /^\d+$/.test(String(parts[offset + 1] || ''));
        }

        return false;
    }

    getSupportLabel(supported) {
        return this.app.t(supported ? 'musicQueue.supported' : 'musicQueue.unsupported');
    }

    renderSupportIndicator(supported, { compact = false } = {}) {
        const label = this.getSupportLabel(supported);
        const className = supported ? 'is-supported' : 'is-unsupported';
        const icon = supported ? '✓' : '×';
        return `<span class="music-url-queue-support ${className}${compact ? ' is-compact' : ''}" title="${this.app.escapeHtml(label)}" aria-label="${this.app.escapeHtml(label)}"><span aria-hidden="true">${icon}</span>${compact ? '' : `<span>${this.app.escapeHtml(label)}</span>`}</span>`;
    }

    updateModalInputSupport() {
        if (!this.modalSupportEl) return;
        const value = this.modalInput?.value.trim() || '';
        if (!value) {
            this.modalSupportEl.className = 'music-url-queue-support is-empty';
            this.modalSupportEl.textContent = '';
            this.modalSupportEl.removeAttribute('title');
            this.modalSupportEl.removeAttribute('aria-label');
            if (this.modalAddBtn) this.modalAddBtn.disabled = true;
            return;
        }

        const supported = this.isSupportedUrl(value);
        const label = this.getSupportLabel(supported);
        this.modalSupportEl.className = `music-url-queue-support ${supported ? 'is-supported' : 'is-unsupported'} is-compact`;
        this.modalSupportEl.innerHTML = `<span aria-hidden="true">${supported ? '✓' : '×'}</span>`;
        this.modalSupportEl.title = label;
        this.modalSupportEl.setAttribute('aria-label', label);
        if (this.modalAddBtn) this.modalAddBtn.disabled = false;
    }

    updateButton() {
        if (!this.addBtn) return;
        const input = document.getElementById('urlInput');
        const value = input?.value.trim() || '';
        this.addBtn.style.display = 'inline-flex';
        this.addBtn.disabled = false;
        this.addBtn.title = this.app.t('musicQueue.addButtonTitle');
        this.addBtn.setAttribute('aria-label', this.app.t('musicQueue.addButtonTitle'));
        if (this.countEl) {
            const totalItems = this.items.length + this.textItems.length;
            this.countEl.textContent = String(totalItems);
            this.countEl.style.display = totalItems ? 'inline-flex' : 'none';
        }

        const startButton = document.getElementById('startIntegratedBtn');
        if (startButton && !this.running) {
            // The main Match & Download button is direct-input only. Queue state must
            // never make it runnable or cause it to consume saved queue entries.
            startButton.disabled = !(!!value && this.app.isSpotifyUrl(value));
        }
    }

    render() {
        if (!this.modalEl || !this.listEl) return;
        const title = this.modalEl.querySelector('#musicUrlQueueTitle');
        const hint = this.modalEl.querySelector('#musicUrlQueueHint');
        const summary = this.modalEl.querySelector('#musicUrlQueueSummary');
        const autoLabel = this.modalEl.querySelector('#musicUrlQueueAutoRemoveLabel');
        const done = this.modalEl.querySelector('#musicUrlQueueDone');
        const queueStart = this.modalEl.querySelector('#musicUrlQueueStart');
        const close = this.modalEl.querySelector('#musicUrlQueueClose');

        if (title) title.textContent = this.app.t('musicQueue.title');
        if (hint) hint.textContent = this.app.t('musicQueue.hint');
        if (summary) summary.textContent = this.app.t('musicQueue.summary', { count: this.items.length });
        if (autoLabel) autoLabel.textContent = this.app.t(this.activeTab === 'text' ? 'musicQueue.textAutoRemove' : 'musicQueue.autoRemove');
        if (done) done.textContent = this.app.t('musicQueue.done');
        if (queueStart) {
            const isTextTab = this.activeTab === 'text';
            const isMatching = isTextTab && this.running;
            queueStart.textContent = isTextTab
                ? (isMatching
                    ? (this.textProgress?.phase === 'queueing' ? this.app.t('musicQueue.textQueueingButton') : this.app.t('musicQueue.textMatchingButton'))
                    : this.app.t('musicQueue.textStart'))
                : this.app.t('btn.spotifyIntegrated');
            queueStart.disabled = this.running || (isTextTab ? !this.hasRunnableTextItems() : !this.hasRunnableItems());
            queueStart.classList.toggle('btn-loading', isMatching);
        }
        if (close) close.setAttribute('aria-label', this.app.t('musicQueue.close'));
        if (this.modalInput) this.modalInput.placeholder = this.app.t('musicQueue.urlPlaceholder');
        if (this.modalAddBtn) this.modalAddBtn.textContent = this.app.t('musicQueue.addUrl');
        if (this.autoRemoveCheckbox) {
            this.autoRemoveCheckbox.checked = this.activeTab === 'text'
                ? this.textAutoRemoveTerminal
                : this.autoRemoveSuccessful;
        }
        this.updateModalInputSupport();

        const urlTab = this.modalEl.querySelector('[data-music-queue-tab="urls"]');
        const textTab = this.modalEl.querySelector('[data-music-queue-tab="text"]');
        if (urlTab) urlTab.textContent = this.app.t('musicQueue.tabUrls');
        if (textTab) textTab.textContent = this.app.t('musicQueue.tabText');
        const formatTitle = this.modalEl.querySelector('#musicTextImportFormatTitle');
        const formatHint = this.modalEl.querySelector('#musicTextImportFormatHint');
        const parseHint = this.modalEl.querySelector('#musicTextImportParseHint');
        const textSummary = this.modalEl.querySelector('#musicTextImportSummary');
        if (formatTitle) formatTitle.textContent = this.app.t('musicQueue.textFormatTitle');
        if (formatHint) formatHint.textContent = this.app.t('musicQueue.textFormatHint');
        if (parseHint) parseHint.textContent = this.app.t('musicQueue.textPasteHint');
        if (textSummary) textSummary.textContent = this.app.t('musicQueue.textSummary', { count: this.textItems.length });
        if (this.textInput) {
            this.textInput.placeholder = this.app.t('musicQueue.textPlaceholder');
            this.textInput.disabled = this.running;
        }
        if (this.textAddBtn) {
            this.textAddBtn.textContent = this.app.t('musicQueue.textAdd');
            this.textAddBtn.disabled = this.running;
        }
        this.renderTextProgress();
        this.renderTextItems();
        this.setActiveTabVisualOnly();

        if (!this.items.length) {
            this.listEl.innerHTML = `<div class="music-url-queue-empty">${this.app.escapeHtml(this.app.t('musicQueue.empty'))}</div>`;
            return;
        }

        this.listEl.innerHTML = this.items.map((item, index) => {
            const removable = item.status !== 'running';
            const supported = this.isSupportedUrl(item.url);
            const errorHtml = item.error
                ? `<div class="music-url-queue-error">${this.app.escapeHtml(item.error)}</div>`
                : '';
            return `
                <article class="music-url-queue-item is-${this.app.escapeHtml(item.status)}${supported ? '' : ' is-unsupported-url'}">
                    <div class="music-url-queue-index">${index + 1}</div>
                    <div class="music-url-queue-main">
                        <div class="music-url-queue-meta">
                            <strong>${this.app.escapeHtml(this.getProvider(item.url))}</strong>
                            ${this.renderSupportIndicator(supported, { compact: true })}
                            <span class="music-url-queue-status is-${this.app.escapeHtml(item.status)}">${this.app.escapeHtml(this.getStatusLabel(item.status))}</span>
                        </div>
                        ${item.title
                            ? `<div class="music-url-queue-resolved-title" title="${this.app.escapeHtml(item.title)}">${this.app.escapeHtml(item.title)}</div>`
                            : item.titleStatus === 'loading'
                                ? `<div class="music-url-queue-resolved-title is-loading">${this.app.escapeHtml(this.app.t('musicQueue.titleLoading'))}</div>`
                                : item.titleStatus === 'error'
                                    ? `<div class="music-url-queue-resolved-title is-unavailable">${this.app.escapeHtml(this.app.t('musicQueue.titleUnavailable'))}</div>`
                                    : ''}
                        <div class="music-url-queue-url" title="${this.app.escapeHtml(item.url)}">${this.app.escapeHtml(item.url)}</div>
                        ${errorHtml}
                    </div>
                    <button
                        type="button"
                        class="music-url-queue-remove"
                        data-queue-remove-id="${item.id}"
                        ${removable ? '' : 'disabled'}
                        aria-label="${this.app.escapeHtml(this.app.t('musicQueue.remove'))}"
                        title="${this.app.escapeHtml(this.app.t('musicQueue.remove'))}"
                    >×</button>
                </article>
            `;
        }).join('');
    }

    setActiveTabVisualOnly() {
        if (!this.modalEl) return;
        this.modalEl.querySelectorAll('[data-music-queue-tab]').forEach((button) => {
            const active = button.dataset.musicQueueTab === this.activeTab;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        this.modalEl.querySelectorAll('[data-music-queue-pane]').forEach((pane) => {
            pane.classList.toggle('is-active', pane.dataset.musicQueuePane === this.activeTab);
        });
        const autoRemove = this.modalEl.querySelector('.music-url-queue-auto-remove');
        if (autoRemove) autoRemove.hidden = false;
    }

    getTextStatusLabel(status) {
        const key = {
            pending: 'musicQueue.status.pending',
            running: 'musicQueue.status.matching',
            matched: 'musicQueue.status.matched',
            queued: 'musicQueue.status.queued',
            completed: 'musicQueue.status.completed',
            'not-found': 'musicQueue.status.notFound',
            error: 'musicQueue.status.error'
        }[status] || 'musicQueue.status.pending';
        return this.app.t(key);
    }

    renderTextProgress() {
        const progress = this.modalEl?.querySelector('#musicTextImportProgress');
        if (!progress) return;
        const state = this.textProgress;
        if (!state) {
            this.clearTextProgressHideTimer();
            progress.hidden = true;
            progress.className = 'music-text-import-progress';
            progress.innerHTML = '';
            return;
        }

        const phase = state.phase || 'matching';
        if (phase === 'done') this.scheduleTextProgressHide(state);
        else this.clearTextProgressHideTimer();
        const text = phase === 'matching'
            ? this.app.t('musicQueue.textProgressMatching', { count: state.total })
            : phase === 'queueing'
                ? this.app.t('musicQueue.textProgressQueueing', { matched: state.matched, failed: state.failed })
                : phase === 'done'
                    ? this.app.t('musicQueue.textProgressDone', { matched: state.matched, failed: state.failed })
                    : this.app.t('musicQueue.textProgressError', { error: state.message || this.app.t('musicQueue.unknownError') });
        progress.hidden = false;
        progress.className = `music-text-import-progress is-${phase}`;
        progress.innerHTML = `${phase === 'matching' || phase === 'queueing' ? '<span class="music-text-import-spinner" aria-hidden="true"></span>' : ''}<span>${this.app.escapeHtml(text)}</span>`;
    }

    renderTextItems() {
        const list = this.modalEl?.querySelector('#musicTextImportList');
        if (!list) return;
        if (!this.textItems.length) {
            list.innerHTML = `<div class="music-url-queue-empty">${this.app.escapeHtml(this.app.t('musicQueue.textEmpty'))}</div>`;
            return;
        }
        list.innerHTML = this.textItems.map((item, index) => {
            const matchLabel = item.match?.title
                ? `<div class="music-url-queue-resolved-title">${this.app.escapeHtml(item.match.title)}${item.match.uploader ? ` <span>• ${this.app.escapeHtml(item.match.uploader)}</span>` : ''}</div>`
                : '';
            const errorHtml = item.error ? `<div class="music-url-queue-error">${this.app.escapeHtml(item.error)}</div>` : '';
            return `
                <article class="music-url-queue-item is-${this.app.escapeHtml(item.status)}">
                    <div class="music-url-queue-index">${index + 1}</div>
                    <div class="music-url-queue-main">
                        <div class="music-url-queue-meta">
                            <strong>${this.app.escapeHtml(item.artist || this.app.t('musicQueue.textUnknownArtist'))}</strong>
                            <span class="music-url-queue-status is-${this.app.escapeHtml(item.status)}">${this.app.escapeHtml(this.getTextStatusLabel(item.status))}</span>
                        </div>
                        <div class="music-text-import-query">${this.app.escapeHtml(item.title || item.query)}</div>
                        ${matchLabel}
                        ${errorHtml}
                    </div>
                    <button type="button" class="music-url-queue-remove" data-text-queue-remove-id="${item.id}" ${item.status === 'running' ? 'disabled' : ''} aria-label="${this.app.escapeHtml(this.app.t('musicQueue.remove'))}" title="${this.app.escapeHtml(this.app.t('musicQueue.remove'))}">×</button>
                </article>`;
        }).join('');
    }

    updateAfterMutation() {
        this.persistState();
        this.updateButton();
        this.render();
        const input = document.getElementById('urlInput');
        this.app.onUrlInputChange?.(input?.value || '');
    }

    async startQueue() {
        if (this.running || !this.hasRunnableItems()) return null;
        if (!this.app.spotifyManager?.startIntegratedSpotifyProcess) return null;

        return this.processQueue((item) => this.app.spotifyManager.startIntegratedSpotifyProcess({
            url: item.url,
            queueManaged: true,
            awaitCompletion: true
        }));
    }

    async processQueue(processItem) {
        if (this.running || !this.hasRunnableItems()) return null;
        this.running = true;

        const queueStartButton = this.queueStartBtn || this.modalEl?.querySelector?.('#musicUrlQueueStart') || null;
        const directStartButton = document.getElementById('startIntegratedBtn');
        queueStartButton?.classList.add('btn-loading');
        if (queueStartButton) queueStartButton.disabled = true;
        // SpotifyManager has a single live integrated-job UI/SSE state, so prevent a
        // direct job from being started while a queue item is active.
        if (directStartButton) directStartButton.disabled = true;

        const runIds = this.items
            .filter((item) => ['pending', 'error', 'canceled'].includes(item.status))
            .map((item) => item.id);

        let completed = 0;
        let failed = 0;

        try {
            for (const id of runIds) {
                const item = this.items.find((entry) => entry.id === id);
                if (!item) continue;

                if (!this.isSupportedUrl(item.url)) {
                    failed += 1;
                    item.status = 'error';
                    item.error = this.app.t('musicQueue.unsupportedError');
                    item.jobId = null;
                    this.updateAfterMutation();
                    continue;
                }

                item.status = 'running';
                item.error = null;
                item.jobId = null;
                this.updateAfterMutation();

                let result;
                try {
                    result = await processItem(item);
                } catch (error) {
                    result = { status: 'error', error: error?.message || String(error) };
                }

                const liveItem = this.items.find((entry) => entry.id === id);
                if (!liveItem) continue;

                liveItem.jobId = result?.jobId || liveItem.jobId;
                if (result?.status === 'completed') {
                    completed += 1;
                    if (this.autoRemoveSuccessful) {
                        this.items = this.items.filter((entry) => entry.id !== id);
                    } else {
                        liveItem.status = 'completed';
                    }
                } else {
                    failed += 1;
                    liveItem.status = result?.status === 'canceled' ? 'canceled' : 'error';
                    liveItem.error = result?.error
                        || result?.job?.error
                        || this.app.t('musicQueue.unknownError');
                }

                this.updateAfterMutation();
            }

            this.app.showNotification(
                failed > 0
                    ? this.app.t('musicQueue.finishedWithErrors', { completed, failed })
                    : this.app.t('musicQueue.finished', { completed }),
                failed > 0 ? 'warning' : 'success',
                failed > 0 ? 'default' : 'queue'
            );

            return { completed, failed };
        } finally {
            this.running = false;
            queueStartButton?.classList.remove('btn-loading');
            this.updateAfterMutation();
        }
    }
}
