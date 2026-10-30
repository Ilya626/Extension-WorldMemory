// Search derivatives only. Original source strings and authoritative memory are never changed.
import { hash, terms } from './history.js';
import { historyPacketThreads } from './history-selection.js';

export const HISTORY_VECTOR_CONTENT_REVISION = 'wm-raw384-source-spans-facts-v1';
const TARGET = 384;
const cancelled = () => new DOMException('History vector search cancelled or sources changed.', 'AbortError');
const label = source => source.name || (source.isUser ? 'User' : 'Assistant');
const sourceOrder = (source, node) => Number.isFinite(source.index) ? source.index : Number.isFinite(node.order) ? node.order : Number.MAX_SAFE_INTEGER;
const overlap = (a, b) => a.start < b.end && a.end > b.start;
const compare = (a, b) => a.order - b.order || (a.centerStart ?? a.sourceSpans?.[0]?.start ?? 0)
    - (b.centerStart ?? b.sourceSpans?.[0]?.start ?? 0) || a.id.localeCompare(b.id);
const cosine = (a, an, b, bn) => {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot / (an * bn || 1);
};
const mergeRanges = ranges => {
    const output = [];
    for (const range of ranges.map(r => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start || a.end - b.end)) {
        const last = output.at(-1);
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else output.push(range);
    }
    return output;
};

function sourcesOf(nodes) {
    const sources = new Map(), excluded = new Set(nodes.flatMap(node => (node.sources || []).filter(s => s.hidden).map(s => s.id)));
    for (const node of nodes) {
        if (node.stale) throw new Error('History vector search requires current source packets.');
        if (node.hidden) continue;
        for (const raw of node.sources || []) {
            if (!raw.id || typeof raw.text !== 'string' || !raw.text.trim() || excluded.has(raw.id)) continue;
            if (sources.has(raw.id)) {
                const existing = sources.get(raw.id);
                if (existing.source.text !== raw.text) throw new Error('Conflicting original text for one source ID.');
                existing.nodes.add(node.id); continue;
            }
            const source = { ...raw, text: raw.text }, revision = hash(source.text);
            sources.set(source.id, { source, node: node.id, nodes: new Set([node.id]), order: sourceOrder(source, node), revision });
        }
    }
    return sources;
}

function validSpan(span, entry) {
    return entry && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0
        && span.end > span.start && span.end <= entry.source.text.length
        && span.offsetUnit === 'utf16' && span.endExclusive === true && span.sourceRevision === entry.revision;
}

function rawDocument(entry, ranges) {
    const { source, node, order, revision } = entry, merged = mergeRanges(ranges);
    const sourceSpans = merged.map(range => ({ sourceId: source.id, ...range, offsetUnit: 'utf16', endExclusive: true, sourceRevision: revision }));
    const text = merged.map(range => `${label(source)}: ${source.text.slice(range.start, range.end)}`).join('\n');
    return { id: `raw-window:${node}:${source.id}:${merged.map(r => `${r.start}-${r.end}`).join(',')}`,
        node, kind: 'raw', order, text, search: text, sourceIds: [source.id], sourceSpans,
        completeSourceIds: merged.length === 1 && merged[0].start === 0 && merged[0].end === source.text.length ? [source.id] : [],
        ...(source.sourceKind ? { sourceKind: source.sourceKind } : {}),
        ...(source.sourcePointer ? { sourcePointer: { ...source.sourcePointer } } : {}) };
}

/** Merge during EACH assembly trial, before token counting; partial spans never imply a complete source. */
export function mergeHistoryRawWindows(nodes, selected) {
    const sources = sourcesOf(nodes), groups = new Map(), rest = [];
    for (const doc of selected) {
        if (doc.kind !== 'raw' || !Array.isArray(doc.sourceSpans)) { rest.push(doc); continue; }
        for (const span of doc.sourceSpans) {
            const entry = sources.get(span.sourceId);
            if (!validSpan(span, entry) || !entry.nodes.has(doc.node) || !doc.sourceIds?.includes(span.sourceId)) continue;
            if (!groups.has(span.sourceId)) groups.set(span.sourceId, []);
            groups.get(span.sourceId).push(span);
        }
    }
    const raw = [...groups].map(([id, ranges]) => rawDocument(sources.get(id), ranges));
    return [...rest, ...raw].sort(compare);
}

function queryParts(query) {
    const starts = [...query.matchAll(/^(\d+)[.)]\s+/gm)];
    if (starts.length < 2 || !starts.every((match, i) => Number(match[1]) === i + 1)
        || query.slice(0, starts[0].index).trim()) return [query];
    const parts = starts.map((match, i) => query.slice(match.index + match[0].length, starts[i + 1]?.index ?? query.length).trim());
    // Bound query embedding work while keeping every numbered intent, regardless
    // of list length. Longer lists share views instead of dropping later items.
    const views = Math.min(3, parts.length);
    return Array.from({ length: views }, (_, i) => parts.slice(Math.floor(i * parts.length / views),
        Math.floor((i + 1) * parts.length / views)).join('\n\n'));
}

export function createHistoryVectorRetrieval({ embeddings, countTokens }) {
    if (typeof embeddings?.embed !== 'function' || typeof countTokens !== 'function')
        throw new TypeError('History vector retrieval requires a vector client and token counter.');
    // Chunking is a derivative of the exact source string, scoped to this tokenizer instance.
    const chunkCache = new Map();
    async function chunks(text, check, activity) {
        if (chunkCache.has(text)) {
            const saved = chunkCache.get(text); chunkCache.delete(text); chunkCache.set(text, saved); return saved;
        }
        const counts = new Map();
        const size = async (start, end) => {
            const key = `${start}:${end}`;
            if (!counts.has(key)) {
                check(); const value = await countTokens(text.slice(start, end)); check();
                if (!Number.isFinite(value) || value < 0) throw new Error('History token counter returned an invalid size.');
                counts.set(key, value); activity?.(); check();
            }
            return counts.get(key);
        };
        const boundaries = [...text.matchAll(/[.!?…]+[»”"'’)\]]*(?:\s+|$)|\n+/gu)].map(m => m.index + m[0].length);
        if (boundaries.at(-1) !== text.length) boundaries.push(text.length);
        const result = []; let start = 0, end = 0;
        const push = last => { if (text.slice(start, last).trim()) result.push({ start, end: last }); start = last; end = last; };
        for (const boundary of boundaries) {
            if (await size(start, boundary) <= TARGET) { end = boundary; continue; }
            if (end > start) push(end);
            while (await size(start, boundary) > TARGET) {
                let lo = start + 1, hi = boundary;
                while (lo < hi) {
                    const middle = Math.ceil((lo + hi) / 2);
                    if (await size(start, middle) <= TARGET) lo = middle; else hi = middle - 1;
                }
                let cut = lo;
                if (cut < text.length && /[\uD800-\uDBFF]/u.test(text[cut - 1])) cut--;
                if (cut <= start) throw new Error('Unable to split this source into history windows.');
                push(cut);
            }
            end = boundary;
        }
        if (start < text.length) push(text.length);
        check(); chunkCache.set(text, result);
        while (chunkCache.size > 512) chunkCache.delete(chunkCache.keys().next().value);
        return result;
    }

    async function search({ nodes, query, lemmas = {}, signal, onActivity, onProgress, onQueryVectors, isCurrent, semantic = true } = {}) {
        if (!Array.isArray(nodes) || typeof query !== 'string') throw new TypeError('History search requires nodes and query text.');
        if (!nodes.length || !query.trim()) return [];
        const started = performance.now(), profileId = semantic ? embeddings.profile?.().id : undefined;
        const check = () => {
            if (signal?.aborted || isCurrent?.() === false || (profileId !== undefined && embeddings.profile?.().id !== profileId)) throw cancelled();
        };
        check();
        const sources = sourcesOf(nodes), docs = [], bySource = new Map(), facts = [], threads = [];
        const bag = text => new Set(terms(text).flatMap(term => [term, ...(Array.isArray(lemmas[term]) ? lemmas[term] : [])]));
        const df = new Map(); let sourceCount = 0, ignoredFacts = 0;
        for (const entry of sources.values()) {
            const spans = await chunks(entry.source.text, check, onActivity), group = [];
            for (const [i, span] of spans.entries()) {
                const input = `${label(entry.source)}: ${entry.source.text.slice(span.start, span.end)}`;
                const doc = { id: `raw-center:${entry.node}:${entry.source.id}:${span.start}-${span.end}`, entry, input,
                    order: entry.order, start: span.start, end: span.end,
                    windowStart: spans[Math.max(0, i - 1)].start, windowEnd: spans[Math.min(spans.length - 1, i + 1)].end,
                    words: bag(input), links: [] };
                group.push(doc); docs.push(doc);
                for (const word of doc.words) df.set(word, (df.get(word) || 0) + 1);
            }
            bySource.set(entry.source.id, group);
            check(); onProgress?.({ phase: 'indexing', stage: 'chunking', completed: ++sourceCount, total: sources.size, pending: sources.size - sourceCount }); check();
        }
        const rawCenters = docs.length;
        const memories = nodes.filter(node => !node.hidden && !node.stale && (node.summaryOnly || node.manual)
            && typeof node.detail === 'string' && node.detail.trim()).map(node => {
            const input = `${node.detail}\n${(node.keys || []).filter(key => typeof key === 'string').join('; ')}`;
            return { id: `memory:${node.id}`, kind: 'memory', manual: node.manual, order: node.order,
                text: node.detail, search: input, sourceIds: node.sourceIds, input, words: bag(input), links: [] };
        });
        if (!rawCenters && !memories.length) return [];
        for (const node of nodes) for (const fact of Array.isArray(node.facts) ? node.facts : []) {
            const spans = Array.isArray(fact.sourceSpans) ? fact.sourceSpans : [];
            if (typeof fact.text !== 'string' || !fact.text.trim() || !spans.length || !spans.every(span => {
                const entry = sources.get(span.sourceId);
                return entry?.nodes.has(node.id) && fact.sourceIds?.includes(span.sourceId) && validSpan(span, entry)
                    && entry.source.text.slice(span.start, span.end) === fact.text;
            })) { ignoredFacts++; continue; }
            const index = facts.length, input = fact.text + '\n' + (Array.isArray(fact.keys) ? fact.keys.filter(k => typeof k === 'string').join('; ') : '');
            facts.push({ input, words: bag(input) });
            for (const span of spans) for (const doc of bySource.get(span.sourceId) || []) if (overlap(doc, span)) {
                doc.links.push({ fact: index });
                // Exact excerpts may cross several centers. The matched candidate restores the entire addressed excerpt.
                doc.windowStart = Math.min(doc.windowStart, span.start); doc.windowEnd = Math.max(doc.windowEnd, span.end);
            }
        }
        // Current per-packet Lprime + keys navigate only their own available originals.
        // A thread is neither an exact-span fact nor a source witness.
        for (const node of historyPacketThreads(nodes)) {
            const linked = docs.filter(doc => doc.entry.nodes.has(node.id) && node.sourceIds.includes(doc.entry.source.id));
            if (!linked.length) continue;
            const input = node.compact + '\n' + (Array.isArray(node.keys) ? node.keys.filter(key => typeof key === 'string').join('; ') : '');
            const index = threads.length;
            threads.push({ input, words: bag(input) });
            for (const doc of linked) (doc.threadLinks ||= []).push({ thread: index });
        }
        // Saved edits and source-less summaries are independent detail candidates, not raw/fact navigation.
        // Add them to the same direct cosine/lexical channels without a manual-first priority.
        for (const memory of memories) {
            docs.push(memory);
            for (const word of memory.words) df.set(word, (df.get(word) || 0) + 1);
        }
        const packetThreads = threads.length;
        // Reply hints are untrusted navigation for their exact original, never evidence or a scene frame.
        // Keep them out of raw inputs, source spans and rendered history.
        for (const entry of sources.values()) {
            const hint = entry.source.hint;
            if (hint?.fingerprint !== entry.revision) continue;
            const input = [hint.anchor, hint.keys, hint.carry].filter(value => typeof value === 'string' && value.trim()).join('; ');
            if (!input) continue;
            const index = threads.length;
            threads.push({ input, words: bag(input) });
            for (const doc of bySource.get(entry.source.id) || []) (doc.threadLinks ||= []).push({ thread: index });
        }
        const replyHints = threads.length - packetThreads;
        const documentInputs = [...docs.map(doc => doc.input), ...facts.map(fact => fact.input), ...threads.map(thread => thread.input)];
        const vectors = semantic ? await embeddings.embed(documentInputs, { role: 'document', signal, onActivity, isCurrent,
            onProgress: progress => { check(); onProgress?.({ ...progress, phase: 'indexing', stage: 'documents' }); check(); } }) : [];
        check();
        if (semantic && vectors.length !== documentInputs.length) throw new Error('History document vector count does not match the current index.');
        docs.forEach((doc, i) => { doc.vector = vectors[i]; doc.norm = semantic ? Math.hypot(...doc.vector) : 0; });
        facts.forEach((fact, i) => { fact.vector = vectors[docs.length + i]; fact.norm = semantic ? Math.hypot(...fact.vector) : 0; });
        threads.forEach((thread, i) => { thread.vector = vectors[docs.length + facts.length + i]; thread.norm = semantic ? Math.hypot(...thread.vector) : 0; });
        for (const doc of docs) for (const link of doc.links) {
            const fact = facts[link.fact]; link.affinity = semantic ? Math.max(0, cosine(doc.vector, doc.norm, fact.vector, fact.norm)) : 1;
        }
        for (const doc of docs) for (const link of doc.threadLinks || []) {
            const thread = threads[link.thread];
            link.affinity = semantic ? Math.max(0, cosine(doc.vector, doc.norm, thread.vector, thread.norm)) : 1;
        }
        const parts = queryParts(query);
        const queries = semantic ? await embeddings.embed(parts, { role: 'query', signal, onActivity, isCurrent,
            onProgress: progress => { check(); onProgress?.({ ...progress, phase: 'searching', stage: 'query' }); check(); } }) : [];
        check();
        if (semantic && queries.length !== parts.length) throw new Error('History query vector count does not match query parts.');
        onQueryVectors?.(queries);
        const rankings = parts.map((part, partIndex) => {
            const vector = queries[partIndex], norm = semantic ? Math.hypot(...vector) : 0, words = bag(part);
            const relevance = facts.map(fact => semantic ? Math.max(0, cosine(fact.vector, fact.norm, vector, norm))
                : [...words].filter(word => fact.words.has(word)).length);
            const direct = semantic ? docs.map(doc => cosine(doc.vector, doc.norm, vector, norm)) : [];
            const lexical = docs.map(doc => [...words].reduce((sum, word) => sum + (doc.words.has(word)
                ? Math.log(1 + docs.length / (df.get(word) || 1)) : 0), 0) / Math.pow(Math.max(1, doc.words.size), .15));
            const guided = docs.map(doc => doc.links.reduce((best, link) => Math.max(best, relevance[link.fact] * link.affinity), 0));
            const threadRelevance = threads.map(thread => semantic ? Math.max(0, cosine(thread.vector, thread.norm, vector, norm))
                : [...words].filter(word => thread.words.has(word)).length);
            const threadGuided = threads.length ? docs.map(doc => (doc.threadLinks || []).reduce((best, link) =>
                Math.max(best, threadRelevance[link.thread] * link.affinity), 0)) : null;
            const fused = new Float64Array(docs.length);
            for (const [scores, positiveOnly] of [...(semantic ? [[direct, false]] : []), [lexical, true], [guided, true],
                ...(threadGuided ? [[threadGuided, true]] : [])]) {
                const order = [...scores.keys()].filter(i => !positiveOnly || scores[i] > 0)
                    .sort((a, b) => scores[b] - scores[a] || compare({ ...docs[a], centerStart: docs[a].start }, { ...docs[b], centerStart: docs[b].start }));
                order.forEach((i, position) => { fused[i] += 1 / (61 + position); });
            }
            return docs.map((doc, i) => ({ doc, score: fused[i] })).filter(item => item.score > 0).sort((a, b) => b.score - a.score
                || compare({ ...a.doc, centerStart: a.doc.start }, { ...b.doc, centerStart: b.doc.start }));
        });
        const output = [], seen = new Set();
        const recentFallback = rankings.every(list => !list.length);
        if (recentFallback) rankings[0] = docs.map(doc => ({ doc, score: 0 })).sort((a, b) =>
            b.doc.order - a.doc.order || (b.doc.start ?? 0) - (a.doc.start ?? 0));
        // Interleave numbered intents; ordinary prose uses a single query.
        for (let rank = 0; rank < docs.length; rank++) for (let part = 0; part < rankings.length; part++) {
            const hit = rankings[part][rank]; if (!hit) continue;
            const { doc, score } = hit;
            if (doc.kind === 'memory') {
                if (seen.has(doc.id)) continue;
                seen.add(doc.id);
                const { id, kind, manual, order, text, search, sourceIds } = doc;
                output.push({ id, kind, manual, order, text, search, sourceIds, score, queryPart: part + 1 });
                continue;
            }
            const ranges = [{ start: doc.windowStart, end: doc.windowEnd }];
            const source = doc.entry.source;
            if (source.text.startsWith('[Older WI UID0 |')) {
                const end = source.text.indexOf('\n'); if (end > 0) ranges.push({ start: 0, end });
            }
            const result = rawDocument(doc.entry, ranges);
            if (seen.has(result.id)) continue;
            seen.add(result.id); output.push({ ...result, score, queryPart: part + 1,
                centerSpans: [{ sourceId: source.id, start: doc.start, end: doc.end, offsetUnit: 'utf16', endExclusive: true, sourceRevision: doc.entry.revision }] });
        }
        check();
        output.diagnostics = { profileId, contentRevision: HISTORY_VECTOR_CONTENT_REVISION, sources: sources.size, rawCenters,
            indexedFacts: facts.length, ignoredUnaddressedOrStaleFacts: ignoredFacts, queryParts: parts.length, semantic, recentFallback,
            indexedMemories: memories.length, indexedPacketThreads: packetThreads, indexedReplyHints: replyHints,
            rankingPolicy: `RRF60 raw${memories.length ? '/memory' : ''} cosine + lemma lexical + exact-span-linked fact feedback${packetThreads ? ' + packet-linked Lprime/key navigation' : ''}${replyHints ? ' + source-linked reply-hint navigation' : ''}; numbered parts interleaved`,
            renderingPolicy: 'raw384 centers +/-1; retain complete verified excerpt and original imported title', elapsedMs: performance.now() - started };
        return output;
    }
    return { search, mergeSelected: mergeHistoryRawWindows };
}
