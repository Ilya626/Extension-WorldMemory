// Extra primary-key reasons only. Native WI owns secondary conditions and activation.
import { hash, splitHint } from './history.js';

export const SEMANTIC_WI_CONTENT_REVISION = 'wm-wi-content-keys-v1';
const LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
const rawKeys = keys => typeof keys?.toJSON === 'function' ? keys.toJSON() : keys;
const cancelled = () => new DOMException('Semantic WI sources changed.', 'AbortError');
const bounded = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** Same exact query input as history; never substitute a hidden keyword for the post. */
export function semanticWIQuery(chat = []) {
    return splitHint(chat.findLast(message => message.is_user && !message.is_system && !message.is_hidden
        && typeof message.mes === 'string' && message.mes.trim())?.mes || '').text;
}

function literalKey(text) {
    const pattern = text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    new RegExp(pattern, 'u');
    return `/${pattern}/u`;
}

// Independent, overlapping source windows keep old vectors reusable as the native
// cumulative scan grows. Never send the cumulative 24k passage to a 2048 backend.
function sourceWindows(sources) {
    const windows = new Set();
    for (const text of sources) {
        for (let start = 0; start < text.length;) {
            let end = Math.min(start + 1024, text.length);
            if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
            const window = text.slice(start, end).trim();
            if (window) windows.add(window);
            if (end === text.length) break;
            start = end - 128;
            if (/[\uDC00-\uDFFF]/u.test(text[start])) start++;
        }
    }
    return [...windows];
}

function entriesOf(payload) {
    const rows = new Map();
    for (const name of LISTS) for (const entry of payload[name] || []) {
        // Disabled/constant/keyless entries keep their original native path.
        if (!entry || entry.disable || entry.constant || typeof entry.world !== 'string' || entry.uid == null
            || !Array.isArray(entry.key) || !rawKeys(entry.key)?.some(key => typeof key === 'string' && key.trim())
            || typeof entry.content !== 'string' || !entry.content.trim()) continue;
        const id = JSON.stringify([entry.world, entry.uid]), serialized = JSON.stringify(entry);
        const existing = rows.get(id);
        if (existing && existing.serialized !== serialized) {
            // One native identity with conflicting revisions cannot be a semantic candidate.
            existing.conflict = true; continue;
        }
        if (!existing) rows.set(id, { id, world: entry.world, uid: entry.uid, serialized, revision: hash(serialized),
            input: [entry.comment || '', rawKeys(entry.key).join('; '), entry.content].filter(Boolean).join('\n') });
    }
    return [...rows.values()].filter(row => !row.conflict);
}

function similarity(a, b) {
    if (!a?.length || a.length !== b?.length) throw new Error('Invalid WI vector shape.');
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
    const value = dot / Math.sqrt(aa * bb);
    if (!Number.isFinite(value)) throw new Error('Invalid WI vector value.');
    return Math.max(-1, Math.min(1, value));
}

/**
 * Inject the SAME embedding client used by history; no transport/provider is created here.
 * settings(): {enabled, wiSemantic, wiSemanticTopK?, wiSemanticThreshold?}.
 * Optional prepare() warms the shared query cache; every native scan reads its own available entries.
 */
export function createSemanticWIRuntime({ ctx, settings, embeddings, sourceQueries = () => null,
    sourceSignal = () => undefined, onUpdate = () => {} }) {
    let serial = 0, prepared = null, index = new Map();
    const controllers = new Set();
    const notify = () => { try { onUpdate(); } catch (error) { console.warn('[WorldMemory] WI status update failed.', error); } };
    const config = () => { const value = settings(); return {
        enabled: Boolean(value.enabled && value.wiSemantic),
        topK: Math.floor(bounded(value.wiSemanticTopK, 6, 0, 32)),
        threshold: bounded(value.wiSemanticThreshold, .45, -1, 1),
    }; };
    const contextKey = () => {
        const context = ctx(), chat = context.chat || [], last = chat.at(-1);
        return JSON.stringify([context.chatId, chat.length, sourceQueries() ?? semanticWIQuery(chat), last?.mes, last?.swipe_id]);
    };
    function invalidate() {
        serial++; for (const controller of controllers) controller.abort(); controllers.clear();
        prepared = null; index.clear();
        notify();
    }
    function job() {
        const context = ctx(), metadata = context.chatMetadata, chat = context.chat;
        const sources = sourceQueries();
        const revision = contextKey(), run = serial, options = config(), profileId = embeddings?.profile?.().id;
        if (!profileId || typeof embeddings?.embed !== 'function') throw new Error('Embedding provider unavailable.');
        const controller = new AbortController(); controllers.add(controller);
        const signal = sources === null ? undefined : sourceSignal();
        const abort = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const current = () => {
            try { return !controller.signal.aborted && run === serial && ctx().chatMetadata === metadata
                && ctx().chat === chat && contextKey() === revision && JSON.stringify(config()) === JSON.stringify(options)
                && embeddings.profile().id === profileId; } catch { return false; }
        };
        const check = () => { if (!current()) throw cancelled(); };
        const queries = sources === null ? [semanticWIQuery(chat)] : sourceWindows(sources);
        return { options, profileId, queries, controller, current, check,
            done: () => { signal?.removeEventListener('abort', abort); controllers.delete(controller); }, revision };
    }
    const vectorArgs = (work, role) => ({ role, signal: work.controller.signal, isCurrent: work.current });

    async function prepare(_processedChat, _size, _abort, _type) {
        if (!config().enabled) { invalidate(); return; }
        prepared = null;
        let work;
        try {
            work = job(); if (!work.queries.some(query => query.trim()) || !work.options.topK) return;
            await embeddings.embed(work.queries, vectorArgs(work, 'query')); work.check();
        } catch (error) {
            if (work && !work.current()) return;
            prepared = { status: 'keys-only', profileId: work?.profileId, contextRevision: work && hash(work.revision),
                reason: error.name === 'AbortError' ? 'changed' : 'provider-unavailable', error: error.message, selected: [] };
        } finally { work?.done(); notify(); }
    }

    async function onEntriesLoaded(payload) {
        if (!config().enabled) { invalidate(); return; }
        // A failed query warm-up must not wait for the same unavailable endpoint
        // again during the following native scan. The next generation prepare,
        // settings change or source change retries normally; RP uses native keys.
        if (prepared?.reason === 'provider-unavailable') {
            try { if (prepared.profileId === embeddings.profile().id && prepared.contextRevision === hash(contextKey())) return; }
            catch { return; }
        }
        prepared = null; index.clear();
        let work;
        try {
            work = job();
            const rows = entriesOf(payload);
            if (!work.queries.some(query => query.trim()) || !rows.length || !work.options.topK) {
                prepared = { status: 'keys-only', candidates: rows.length, selected: [] }; return;
            }
            const signature = JSON.stringify(rows.map(row => [row.id, row.serialized]));
            // This index is WI-only and contains exactly this scan's eligible available identities.
            index = new Map(rows.map(row => [row.id, row]));
            const vectors = await embeddings.embed(rows.map(row => row.input), { ...vectorArgs(work, 'document'),
                onProgress: progress => {
                    work.check(); prepared = { status: 'indexing', candidates: rows.length,
                        completed: progress.completed, total: progress.total, selected: [] }; notify();
                } });
            work.check();
            const queries = await embeddings.embed(work.queries, vectorArgs(work, 'query'));
            work.check();
            if (vectors.length !== rows.length || queries.length !== work.queries.length) throw new Error('WI vector count mismatch.');
            if (JSON.stringify(entriesOf(payload).map(row => [row.id, row.serialized])) !== signature) throw cancelled();
            const selected = rows.map((row, i) => {
                const scores = queries.map(query => similarity(vectors[i], query));
                const score = Math.max(...scores), queryIndex = scores.indexOf(score);
                return { ...row, score, queryIndex };
            })
                .filter(row => row.score >= work.options.threshold)
                .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, work.options.topK);
            const byId = new Map(selected.map(row => [row.id, row])), changes = [];
            for (const name of LISTS) for (const [position, entry] of (payload[name] || []).entries()) {
                const hit = byId.get(JSON.stringify([entry.world, entry.uid]));
                if (!hit || JSON.stringify(entry) !== hit.serialized) continue;
                const reason = literalKey(work.queries[hit.queryIndex]);
                const original = entry.key, raw = rawKeys(original);
                if (original.includes(reason)) continue;
                const keys = [...original, reason];
                // Compose with RussianWI in either order. ST hashes raw keys, then clones live keys.
                Object.defineProperty(keys, 'toJSON', { value: () => raw });
                changes.push([payload[name], position, { ...entry, key: keys }]);
            }
            work.check();
            // Keep the native event arrays themselves: ST retains their original references.
            for (const [list, position, entry] of changes) list[position] = entry;
            prepared = { status: 'ready', profileId: work.profileId,
                queryRevision: hash(work.queries.length === 1 ? work.queries[0] : JSON.stringify(work.queries)),
                queryWindows: work.queries.length, sourceScoped: sourceQueries() !== null,
                contentRevision: SEMANTIC_WI_CONTENT_REVISION, candidates: rows.length,
                topK: work.options.topK, threshold: work.options.threshold,
                selected: selected.map(({ world, uid, revision, score }) => ({ world, uid, revision, score })),
                transformed: changes.length };
        } catch (error) {
            if (work && !work.current()) return;
            prepared = { status: 'keys-only', profileId: work?.profileId, contextRevision: work && hash(work.revision),
                reason: error.name === 'AbortError' ? 'changed' : 'provider-unavailable', error: error.message, selected: [] };
        } finally { work?.done(); notify(); }
    }

    const context = ctx(), events = context.eventTypes || context.event_types, listeners = [];
    const listen = (event, handler) => { if (event) { context.eventSource.on(event, handler); listeners.push([event, handler]); } };
    listen(events.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    for (const event of [events.CHAT_CHANGED, events.MESSAGE_SENT, events.MESSAGE_RECEIVED, events.MESSAGE_EDITED, events.MESSAGE_UPDATED, events.MESSAGE_SWIPED,
        events.MESSAGE_DELETED, events.WORLDINFO_UPDATED, events.GENERATION_STOPPED].filter(Boolean)) listen(event, invalidate);
    return { prepare, invalidate, onEntriesLoaded,
        inspect: () => prepared ? { ...prepared, selected: prepared.selected.map(row => ({ ...row })), indexed: index.size } : null,
        dispose() { invalidate(); for (const [event, handler] of listeners) context.eventSource.removeListener(event, handler); } };
}

export const installSemanticWI = createSemanticWIRuntime;
