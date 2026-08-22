const MAX_PATHS_PER_REQUEST = 250;
const DEFAULT_CACHE_TTL_MS = 15000;
const DEFAULT_FAILURE_CACHE_TTL_MS = 5000;

// Collects every output path that can keep a restored job visible.
export function collectJobOutputPaths(job) {
    const paths = [];

    if (Array.isArray(job?.resultPath)) {
        for (const result of job.resultPath) {
            if (!result || result.error) continue;
            const outputPath = result.outputPath || result.path;
            if (outputPath) paths.push(outputPath);
        }
    } else if (typeof job?.resultPath === 'string' && job.resultPath) {
        paths.push(job.resultPath);
    } else if (job?.resultPath && typeof job.resultPath === 'object') {
        const outputPath = job.resultPath.outputPath || job.resultPath.path;
        if (outputPath) paths.push(outputPath);
    }

    if (job?.zipPath) paths.push(job.zipPath);
    return paths;
}

export class OutputExistenceClient {
    constructor({
        fetchImpl = (...args) => globalThis.fetch(...args),
        cacheTtlMs = DEFAULT_CACHE_TTL_MS,
        failureCacheTtlMs = DEFAULT_FAILURE_CACHE_TTL_MS
    } = {}) {
        this.fetchImpl = fetchImpl;
        this.cacheTtlMs = cacheTtlMs;
        this.failureCacheTtlMs = failureCacheTtlMs;
        this.cache = new Map();
        this.inFlight = new Map();
        this.pendingPaths = new Set();
        this.flushScheduled = false;
    }

    normalizePath(rawPath) {
        return String(rawPath || '').trim();
    }

    getCached(path) {
        const cached = this.cache.get(path);
        if (!cached) return null;
        if (Date.now() >= cached.expiresAt) {
            this.cache.delete(path);
            return null;
        }
        return cached.exists;
    }

    setCached(path, exists, ttlMs = this.cacheTtlMs) {
        this.cache.set(path, {
            exists: !!exists,
            expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0)
        });
    }

    enqueue(path) {
        const current = this.inFlight.get(path);
        if (current) return current.promise;

        let resolveRequest;
        const promise = new Promise((resolve) => {
            resolveRequest = resolve;
        });

        this.inFlight.set(path, { promise, resolve: resolveRequest });
        this.pendingPaths.add(path);
        this.scheduleFlush();
        return promise;
    }

    scheduleFlush() {
        if (this.flushScheduled) return;
        this.flushScheduled = true;
        Promise.resolve().then(() => this.flushPending());
    }

    resolvePath(path, exists, ttlMs) {
        this.setCached(path, exists, ttlMs);
        const pending = this.inFlight.get(path);
        this.inFlight.delete(path);
        pending?.resolve(!!exists);
    }

    async fetchChunk(paths) {
        try {
            const response = await this.fetchImpl('/api/outputs/exists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths }),
                cache: 'no-store'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const returned = new Map();
            for (const item of Array.isArray(data?.items) ? data.items : []) {
                const path = this.normalizePath(item?.path);
                if (path) returned.set(path, !!item.exists);
            }

            for (const path of paths) {
                // A missing entry means the response was incomplete. Fail open so a
                // transient server/proxy issue never deletes a completed job.
                const exists = returned.has(path) ? returned.get(path) : true;
                this.resolvePath(path, exists, this.cacheTtlMs);
            }
        } catch (_error) {
            for (const path of paths) {
                this.resolvePath(path, true, this.failureCacheTtlMs);
            }
        }
    }

    async flushPending() {
        this.flushScheduled = false;
        const paths = Array.from(this.pendingPaths);
        this.pendingPaths.clear();

        for (let offset = 0; offset < paths.length; offset += MAX_PATHS_PER_REQUEST) {
            await this.fetchChunk(paths.slice(offset, offset + MAX_PATHS_PER_REQUEST));
        }

        if (this.pendingPaths.size) this.scheduleFlush();
    }

    async checkMany(rawPaths) {
        const paths = Array.from(new Set(
            (Array.isArray(rawPaths) ? rawPaths : [])
                .map((path) => this.normalizePath(path))
                .filter(Boolean)
        ));
        const results = new Map();

        await Promise.all(paths.map(async (path) => {
            const cached = this.getCached(path);
            const exists = cached === null ? await this.enqueue(path) : cached;
            results.set(path, exists);
        }));

        return results;
    }

    async check(rawPath) {
        const path = this.normalizePath(rawPath);
        if (!path) return false;
        const results = await this.checkMany([path]);
        return results.get(path) ?? false;
    }
}

export const outputExistenceClient = new OutputExistenceClient();
