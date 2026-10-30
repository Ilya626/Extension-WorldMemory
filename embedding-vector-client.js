// Raw vectors for local retrieval. No ST vector routes, source-memory writes or secret lookup.
import { hash } from './history.js';

export const LOCAL_EMBEDDING_DEFAULTS = Object.freeze({
    apiUrl: 'http://127.0.0.1:8081', model: 'embeddinggemma-2-Q8_0.gguf',
    revision: 'sha256:2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
    quant: 'Q8_0', dimensions: 768, pooling: 'mean', normalization: 'L2', includePrompt: true,
    documentPrefix: 'title: none | text: ', queryPrefix: 'task: search result | query: ',
});

export const API_EMBEDDING_DEFAULTS = Object.freeze({
    model: 'gemini-embedding-001', dimensions: 768, transport: 'google-native',
    revision: 'gemini-embedding-001', authStyle: 'auto', batchSize: 64, maxBatchCharacters: 24000,
});
const DB_NAME = 'world-memory-embedding-vectors-v1';
const STORE = 'vectors';
class VectorResponseError extends Error {}
const cancelled = () => new DOMException('Embedding operation cancelled or its context changed.', 'AbortError');
const prefixOnce = (text, prefix) => prefix && !text.startsWith(prefix) ? prefix + text : text;

/** Preserve custom gateway paths. A complete endpoint is also accepted. */
export function embeddingEndpoint(base, transport, model) {
    let url;
    try { url = new URL(base); } catch { throw new Error('Configure a browser-accessible embedding URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw new Error('Embedding URL must be HTTP(S), without user-info or a fragment.');
    let path = url.pathname.replace(/\/+$/, '');
    if (transport === 'google-native') {
        if (!path.endsWith(':batchEmbedContents')) {
            path = path.replace(/\/chat\/completions$/, '').replace(/\/embeddings$/, '');
            path = path.replace(/\/v1$/, '/v1beta');
            if (!path.endsWith('/v1beta')) path += '/v1beta';
            path += `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:batchEmbedContents`;
        }
    } else if (!path.endsWith('/embeddings')) {
        const chatEndpoint = path.endsWith('/chat/completions');
        path = path.replace(/\/chat\/completions$/, '');
        if (!chatEndpoint && !path.endsWith('/v1')) path += '/v1';
        path += '/embeddings';
    }
    url.pathname = path;
    return url.href;
}

function resolve(config, summary) {
    const mode = config.mode === 'hosted' ? 'api' : config.mode || 'api';
    if (!['api', 'local'].includes(mode)) throw new Error('Unknown embedding connection mode.');
    const local = mode === 'local';
    const settings = local ? { ...LOCAL_EMBEDDING_DEFAULTS, ...config.local } : { ...API_EMBEDDING_DEFAULTS, ...config.api };
    const inherited = !local && summary?.connectionSource === 'openai' ? summary : {};
    const url = settings.url ?? settings.apiUrl ?? inherited.openaiUrl;
    if (typeof url !== 'string' || !url.trim())
        throw new Error('Set an embedding URL, or use WorldMemory OpenAI Compatible. Opaque connection profiles need explicit embedding settings.');
    const key = local ? '' : settings.key ?? inherited.openaiKey ?? '';
    if (typeof key !== 'string') throw new Error('Provide the embedding API key explicitly; connection-profile secrets are not read.');
    const transport = local ? 'openai' : settings.transport;
    if (!['google-native', 'openai'].includes(transport)) throw new Error('Unknown embedding transport.');
    const requestedAuth = local ? 'none' : settings.authStyle ?? 'auto';
    const authStyle = requestedAuth === 'auto' ? (transport === 'google-native' ? 'x-goog-api-key' : 'bearer') : requestedAuth;
    if (!['x-goog-api-key', 'bearer', 'none'].includes(authStyle)) throw new Error('Unknown embedding authentication style.');
    const model = settings.model, dimensions = settings.dimensions;
    if (typeof model !== 'string' || !model.trim() || !Number.isInteger(dimensions) || dimensions < 1)
        throw new Error('Embedding model and positive integer dimensions are required.');
    const endpoint = embeddingEndpoint(url.trim(), transport, model);
    // Gemini Embedding 2 uses textual task instructions instead of taskType.
    // Keep the 001 protocol and cache identity unchanged.
    const instructionTasks = !local && /^gemini-embedding-2(?:-|$)/.test(model.replace(/^models\//, ''));
    const fields = { version: 1, mode, transport, authStyle, endpointId: hash(endpoint), model, dimensions,
        revision: (local ? settings.revision : config.api?.revision) || model, normalization: 'L2',
        pooling: local ? settings.pooling : 'provider', quant: local ? settings.quant : null,
        includePrompt: local ? settings.includePrompt : instructionTasks,
        documentPrefix: local ? settings.documentPrefix : instructionTasks ? 'title: none | text: ' : '',
        queryPrefix: local ? settings.queryPrefix : instructionTasks ? 'task: search result | query: ' : '',
        contentRevision: config.contentRevision || 'wm-raw-fact-input-v1',
        taskPolicy: local || instructionTasks ? 'prefixed-search' : 'RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY' };
    if (local && (fields.pooling !== 'mean' || settings.normalization !== 'L2' || fields.includePrompt !== true
        || typeof fields.documentPrefix !== 'string' || typeof fields.queryPrefix !== 'string'))
        throw new Error('Local embedding settings require mean pooling, L2 and document/query prefixes.');
    const identity = JSON.stringify(fields), profile = Object.freeze({ ...fields, id: hash(identity) });
    const batchSize = settings.batchSize ?? (local ? 1 : 64), maxBatchCharacters = settings.maxBatchCharacters ?? 24000;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64 || !Number.isFinite(maxBatchCharacters) || maxBatchCharacters < 1)
        throw new Error('Invalid embedding batch limits.');
    return { profile, identity, endpoint, key: key.trim(), batchSize, maxBatchCharacters };
}

function normalize(value, dimensions) {
    if (!(Array.isArray(value) || value instanceof Float32Array) || value.length !== dimensions)
        throw new VectorResponseError('Embedding response has an unexpected vector shape.');
    const result = new Float32Array(dimensions);
    let squared = 0;
    for (let i = 0; i < dimensions; i++) {
        if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) throw new VectorResponseError('Embedding response contains a non-finite value.');
        squared += value[i] * value[i];
    }
    const norm = Math.sqrt(squared);
    if (!Number.isFinite(norm) || norm === 0) throw new VectorResponseError('Embedding response contains a zero or invalid vector.');
    for (let i = 0; i < dimensions; i++) result[i] = value[i] / norm;
    return result;
}

/** IndexedDB is an optional derivative cache; any storage failure keeps memory caching usable. */
function vectorCache(indexedDB, memoryLimit) {
    const memory = new Map();
    let opening, database, disabled = !indexedDB, retryAt = 0;
    const remember = (key, vector) => {
        memory.delete(key); memory.set(key, vector);
        while (memory.size > memoryLimit) memory.delete(memory.keys().next().value);
    };
    const fallback = () => { disabled = true; retryAt = Date.now() + 60000; database?.close(); database = null; };
    const open = () => {
        // Storage can recover while ST remains open. Keep using RAM meanwhile
        // and retry on later work, without deleting paid reusable vectors.
        if (disabled && indexedDB && Date.now() >= retryAt) { disabled = false; opening = undefined; }
        if (disabled) return Promise.resolve(null);
        return opening ||= new Promise(resolve => {
            let settled = false;
            const done = db => { if (!settled) { settled = true; clearTimeout(timer); resolve(db); } else db?.close(); };
            const timer = setTimeout(() => { fallback(); done(null); }, 3000);
            try {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
                };
                request.onerror = request.onblocked = () => { fallback(); done(null); };
                request.onsuccess = () => {
                    if (disabled || settled) { request.result.close(); done(null); return; }
                    database = request.result;
                    database.onversionchange = fallback;
                    done(database);
                };
            } catch { fallback(); done(null); }
        });
    };
    const write = (db, rows) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = event => reject(tx.error || event.target?.error || new Error('Embedding cache write failed.'));
        for (const row of rows) store.put(row);
    });
    // Under storage pressure, retain the current vector space. Other profiles
    // remain configured and can rebuild derivatives if selected again.
    const pruneOtherProfiles = (db, identity) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite'), request = tx.objectStore(STORE).openCursor();
        let deleted = 0;
        tx.oncomplete = () => resolve(deleted);
        tx.onerror = tx.onabort = event => reject(tx.error || event.target?.error || new Error('Embedding cache cleanup failed.'));
        request.onsuccess = () => {
            const cursor = request.result; if (!cursor) return;
            let current = false;
            try { current = JSON.parse(cursor.key)[0] === identity; } catch { /* Invalid derivative key. */ }
            if (!current) { cursor.delete(); deleted++; }
            cursor.continue();
        };
    });
    return {
        state: () => ({ storage: database ? 'indexeddb' : 'memory', memoryEntries: memory.size }),
        async clear() {
            memory.clear();
            // An explicit clear also retries persistent storage after a prior
            // read/write failure; otherwise old IndexedDB rows survive forever.
            if (disabled && indexedDB) { disabled = false; opening = undefined; }
            const db = await open();
            if (db) await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error('Could not clear the browser embedding cache.'));
                tx.objectStore(STORE).clear();
            });
            return { storage: db ? 'indexeddb' : 'memory' };
        },
        async get(keys) {
            const found = new Map(keys.filter(key => memory.has(key)).map(key => [key, memory.get(key)]));
            const missing = keys.filter(key => !found.has(key)), db = missing.length ? await open() : null;
            if (db) try {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE, 'readonly'), store = tx.objectStore(STORE);
                    tx.oncomplete = resolve; tx.onerror = tx.onabort = reject;
                    for (const key of missing) {
                        const request = store.get(key);
                        request.onsuccess = () => { if (request.result?.vector) found.set(key, request.result.vector); };
                    }
                });
            } catch { fallback(); }
            return found;
        },
        async put(rows, check) {
            check();
            const db = await open(); check();
            if (db) try {
                await write(db, rows);
            } catch (error) {
                check();
                if (error?.name === 'QuotaExceededError' && rows.length) try {
                    const deleted = await pruneOtherProfiles(db, JSON.parse(rows[0].key)[0]); check();
                    if (!deleted) throw error;
                    await write(db, rows);
                } catch { check(); fallback(); }
                else fallback();
            }
            check();
            for (const row of rows) remember(row.key, row.vector);
        },
        remember,
    };
}

/**
 * getConfig() -> { mode:'api'|'local', api:{url,key,transport?,model?,dimensions?,revision?}, local:{url?,...}, contentRevision? }
 * API defaults to the SAME native Google task requests used by build-google-cache-20261029.mjs.
 * getSummaryConfig() may supply connectionSource:'openai', openaiUrl, openaiKey; no secret/profile services are queried.
 * embed(inputs, {role:'document'|'query', signal?, onActivity?, onProgress?, isCurrent?}) -> Float32Array[] in input order.
 * ctx is optional; when supplied, queued/in-flight work also checks chatId/chatMetadata before delivering results.
 */
export function createEmbeddingVectorClient({ getConfig = () => ({}), getSummaryConfig = () => ({}), ctx,
    fetchImpl = globalThis.fetch, indexedDB, memoryLimit = 4096, requestTimeoutMs = 120000 } = {}) {
    if (!Number.isInteger(memoryLimit) || memoryLimit < 1) throw new Error('Embedding memory cache limit must be positive.');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('Embedding request timeout must be positive.');
    if (indexedDB === undefined) try { indexedDB = globalThis.indexedDB; } catch { indexedDB = null; }
    const cache = vectorCache(indexedDB, memoryLimit), current = () => resolve(getConfig() || {}, getSummaryConfig() || {});
    let queue = Promise.resolve();
    function snapshot(inputs, args) {
        if (!Array.isArray(inputs) || inputs.some(input => typeof input !== 'string' || !input.trim()))
            throw new Error('Embedding inputs must be nonempty strings.');
        if (!['document', 'query'].includes(args.role)) throw new Error('Embedding role must be document or query.');
        const config = current(), context = ctx?.(), sourceInputs = [...inputs];
        const check = () => {
            if (args.signal?.aborted || args.isCurrent?.() === false) throw cancelled();
            if (ctx && (ctx()?.chatId !== context?.chatId || ctx()?.chatMetadata !== context?.chatMetadata)) throw cancelled();
            let next;
            try { next = current(); } catch { throw cancelled(); }
            if (next.identity !== config.identity) throw cancelled();
        };
        check();
        return { ...config, inputs: sourceInputs, args, check };
    }
    async function request(batch, job) {
        const { profile, endpoint, key, args, check } = job, controller = new AbortController();
        const abort = () => controller.abort(), timer = setTimeout(abort, requestTimeoutMs);
        args.signal?.addEventListener('abort', abort, { once: true });
        const taskType = args.role === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
        const input = batch.map(row => prefixOnce(row.input, args.role === 'query' ? profile.queryPrefix : profile.documentPrefix));
        const authentication = !key || profile.authStyle === 'none' ? {} : profile.authStyle === 'x-goog-api-key'
            ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
        const body = profile.transport === 'google-native' ? { requests: input.map(text => ({ model: 'models/' + profile.model.replace(/^models\//, ''),
            content: { parts: [{ text }] }, ...(profile.taskPolicy === 'prefixed-search' ? {} : { taskType }), outputDimensionality: profile.dimensions })) }
            : { model: profile.model, ...(profile.mode === 'api' ? { dimensions: profile.dimensions,
                ...(profile.taskPolicy === 'prefixed-search' ? {} : { task_type: taskType }) } : {}),
                encoding_format: 'float', input };
        try {
            check(); args.onActivity?.(); check();
            const response = await fetchImpl(endpoint, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error',
                signal: controller.signal, headers: { 'Content-Type': 'application/json', ...authentication },
                body: JSON.stringify(body) });
            check(); args.onActivity?.(); check();
            if (!response.ok) throw new VectorResponseError(`Embedding request failed (HTTP ${response.status}).`);
            const data = await response.json(); check(); args.onActivity?.(); check();
            // Requested model/revision owns the space. Returned model aliases are not hard-gated.
            let vectors;
            if (profile.transport === 'google-native') vectors = data.embeddings?.map(row => row.values);
            else {
                const rows = data.data?.slice().sort((a, b) => a.index - b.index);
                if (!rows || rows.some((row, i) => row.index !== i)) throw new VectorResponseError('Embedding response indices do not match the input batch.');
                vectors = rows.map(row => row.embedding);
            }
            if (!vectors || vectors.length !== batch.length) throw new VectorResponseError('Embedding response count does not match the input batch.');
            return vectors.map(vector => normalize(vector, profile.dimensions));
        } catch (error) {
            check();
            if (controller.signal.aborted) throw new Error('Embedding request timed out.');
            // Never expose fetch URLs, provider error bodies or a key in an error/cause/profile.
            if (error instanceof VectorResponseError) throw error;
            throw new Error('Embedding request failed. Check browser access, CORS and the embedding connection.');
        } finally { clearTimeout(timer); args.signal?.removeEventListener('abort', abort); }
    }
    async function run(job) {
        const { inputs, args, profile, identity, check } = job;
        check();
        const unique = new Map();
        for (const input of inputs) if (!unique.has(input)) unique.set(input, { input, key: JSON.stringify([identity, args.role, input]) });
        const rows = [...unique.values()], saved = await cache.get(rows.map(row => row.key)); check();
        let completed = 0;
        for (const row of rows) {
            if (saved.has(row.key)) try { row.vector = normalize(saved.get(row.key), profile.dimensions); cache.remember(row.key, row.vector); } catch { /* Rebuild this invalid derivative automatically. */ }
            if (row.vector) completed++;
        }
        const progress = phase => { check(); args.onProgress?.({ phase, role: args.role, profileId: profile.id,
            total: rows.length, completed, pending: rows.length - completed, ...cache.state() }); check(); };
        progress('cache');
        const pending = rows.filter(row => !row.vector);
        for (let cursor = 0; cursor < pending.length;) {
            check(); const batch = []; let characters = 0;
            while (cursor < pending.length && batch.length < job.batchSize
                && (!batch.length || characters + pending[cursor].input.length <= job.maxBatchCharacters)) {
                const row = pending[cursor++]; batch.push(row); characters += row.input.length;
            }
            const vectors = await request(batch, job); check();
            batch.forEach((row, i) => { row.vector = vectors[i]; });
            await cache.put(batch.map(row => ({ key: row.key, vector: row.vector })), check); check();
            completed += batch.length; progress('embedding');
        }
        progress('ready'); check();
        return inputs.map(input => new Float32Array(unique.get(input).vector));
    }
    return {
        profile: () => current().profile,
        cacheState: cache.state,
        clearCache() {
            const result = queue.catch(() => {}).then(() => cache.clear());
            queue = result.catch(() => {}); return result;
        },
        embed(inputs, args = {}) {
            let job;
            try { job = snapshot(inputs, args); } catch (error) { return Promise.reject(error); }
            const result = queue.catch(() => {}).then(() => run(job));
            queue = result.catch(() => {});
            if (!args.signal) return result;
            // Stop also settles queued callers promptly; the queued job checks again before any work.
            return new Promise((resolve, reject) => {
                const abort = () => reject(cancelled());
                if (args.signal.aborted) abort(); else args.signal.addEventListener('abort', abort, { once: true });
                result.then(resolve, reject).finally(() => args.signal.removeEventListener('abort', abort));
            });
        },
    };
}
