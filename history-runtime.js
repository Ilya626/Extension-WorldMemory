import { HINT_PROMPT, HISTORY_PROMPT, hash, revision, splitHint, makeGroups, readHistory,
    terms, historyNodes, candidates, rank, assemble } from './history.js';

const REGEX_ID = 'world-memory-service-hint';
export function installHistory({ ctx, settings, state, saveState, status, bridge }) {
    let prepared = null, serial = 0, vectorWarning = '', vectorController = null;
    const countTokens = text => ctx().getTokenCountAsync(text, 0);
    const key = snapshot => JSON.stringify([snapshot.chatId, snapshot.packets.map(p => [p.id, revision(p), p.stale]),
        snapshot.chat.slice(-3).map(m => [m.is_user, m.is_system, m.mes]), settings().historyBaseTokens, settings().historyZoomTokens]);
    function snapshotNow() {
        const snapshot = bridge().snapshot();
        // A hint belongs to the exact selected reply. Edits must not lend its old search words to a new story.
        for (const packet of snapshot.packets) for (const source of packet.sources) {
            if (source.hint?.fingerprint !== hash(source.text)) source.hint = null;
        }
        return snapshot;
    }
    function invalidate() { serial++; vectorController?.abort(); prepared = null; bridge()?.refreshInjection?.(); }
    function attach() {
        bridge()?.setHistoryProvider?.(() => {
            if (!settings().enabled || !settings().history || !prepared) return null;
            return prepared.key === key(snapshotNow()) ? prepared.text : null;
        });
    }
    function syncHintPrompt(enabled = false) {
        ctx().setExtensionPrompt('world_memory_hint', enabled && settings().enabled && settings().history && settings().hints ? HINT_PROMPT : '', 1, 0, false, 0);
    }
    function syncRegex() {
        const scripts = ctx().extensionSettings.regex ??= [];
        const index = scripts.findIndex(script => script.id === REGEX_ID);
        if (settings().enabled && settings().history && settings().hints) {
            const script = { id: REGEX_ID, scriptName: 'World Memory: hide service hint', findRegex: '/<memory_hint>[\\s\\S]*$/gi', replaceString: '',
                trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
            if (index < 0) scripts.push(script); else scripts[index] = script;
        } else if (index >= 0) scripts.splice(index, 1);
    }
    async function onReply(index) {
        if (!settings().enabled || !settings().history) return;
        const message = ctx().chat[Number(index)];
        if (!message || message.is_user || message.is_system) return;
        const parsed = splitHint(message.mes);
        if (!parsed.hint) return;
        message.mes = parsed.text; message.extra ??= {}; message.extra.worldMemoryHint = parsed.hint;
        const swipe = message.swipe_id;
        if (Number.isInteger(swipe)) {
            if (message.swipes?.[swipe] !== undefined) message.swipes[swipe] = parsed.text;
            const info = message.swipe_info?.[swipe];
            if (info) { info.extra ??= {}; info.extra.worldMemoryHint = structuredClone(parsed.hint); }
        }
        delete message.extra.token_count;
        invalidate();
        // ST saves the completed message after MESSAGE_RECEIVED. Saving twice here races its normal finalization.
    }
    async function groupsFor(packet) {
        if (!settings().history || packet.stale || !packet.sources.length) return [];
        const metadata = ctx().chatMetadata;
        const sources = packet.sources.map(source => ({ ...source, hint: source.hint?.fingerprint === hash(source.text) ? source.hint : null }));
        const groups = await makeGroups({ ...packet, sources }, countTokens);
        groups.metadata = metadata;
        return groups;
    }
    function requestFields(groups) {
        return groups.length ? { history_groups: groups.map(group => ({ id: group.id, original_messages: group.sources.map(source => ({
            id: source.id, index: source.index, name: source.name, text: source.text, hint: source.hint || undefined })) })) } : {};
    }
    async function accept(packet, groups, text) {
        if (!groups.length || groups.metadata !== ctx().chatMetadata) return;
        const current = snapshotNow().packets.find(p => p.id === packet.id);
        if (!current || current.stale || revision(current) !== revision(packet)) return;
        const episodes = readHistory(text, groups);
        state().history ??= {};
        if (!episodes) {
            // One failed optional annotation must not re-request every old packet on every new batch.
            const previous = state().history[packet.id];
            state().history[packet.id] = { revision: revision(packet), episodes: previous?.revision === revision(packet) ? previous.episodes : null,
                error: 'Incomplete history markup. Update memory now can retry.' };
            invalidate(); await saveState();
            status('WI response received; optional history markup is missing or incomplete. Ordinary Summaryception memory is kept.');
            return;
        }
        state().history[packet.id] = { revision: revision(packet), episodes };
        invalidate(); await saveState();
    }
    async function prune(snapshot) {
        if (snapshot.metadata !== ctx().chatMetadata) return;
        const history = state()?.history;
        if (!history) return;
        const live = new Set(snapshot.packets.map(p => p.id)); let changed = false;
        for (const id of Object.keys(history)) if (!live.has(id)) { delete history[id]; changed = true; }
        if (changed) { invalidate(); await saveState(); }
    }
    // Uses only an explicitly configured hosted ST vector provider. Never downloads a model on a phone.
    async function semantic(query, docs, owner, signal, onActivity) {
        const config = ctx().extensionSettings.vectors || {};
        const modelField = { openai: 'openai_model', openrouter: 'openrouter_model', cohere: 'cohere_model', togetherai: 'togetherai_model', electronhub: 'electronhub_model', chutes: 'chutes_model', nanogpt: 'nanogpt_model' }[config.source];
        if (!modelField || !config[modelField]) throw new Error('Choose a hosted embedding provider and model in ST Vector Storage first. Keyword search is active.');
        const base = { source: config.source, model: config[modelField], collectionId: `wm_history_${owner}_${hash(config.source + config[modelField])}` };
        async function post(route, args) {
            const response = await fetch(`/api/vector/${route}`, { method: 'POST', headers: ctx().getRequestHeaders(), signal, body: JSON.stringify({ ...base, ...args }) });
            onActivity();
            if (!response.ok) throw new Error(`ST vector ${route}: HTTP ${response.status}. Keyword search is active.`);
            if (route === 'insert' || route === 'delete') return null;
            const result = await response.json(); onActivity(); return result;
        }
        const rows = docs.map((doc, index) => ({ hash: parseInt(hash(doc.id + doc.search).slice(0, 8), 16), text: doc.search, index }));
        const saved = new Set(await post('list', {}));
        const current = new Set(rows.map(row => row.hash));
        const obsolete = [...saved].filter(id => !current.has(id));
        if (obsolete.length) await post('delete', { hashes: obsolete });
        const missing = rows.filter(row => !saved.has(row.hash));
        for (let i = 0; i < missing.length; i += 16) await post('insert', { items: missing.slice(i, i + 16) });
        const result = await post('query', { searchText: query, topK: 12, threshold: config.score_threshold ?? .25 });
        const map = new Map(rows.map((row, i) => [row.hash, docs[i]]));
        return (result.hashes || []).map(id => map.get(id)).filter(Boolean);
    }
    async function prepare(_chat, _size, _abort, type) {
        attach(); syncRegex(); syncHintPrompt(type !== 'quiet');
        if (!settings().enabled || !settings().history || type === 'quiet' || !bridge()?.snapshot) { invalidate(); return; }
        if (!bridge().setHistoryProvider || !bridge().refreshInjection) {
            status('Update Summaryception to the version with addressable history support, then reload ST. Ordinary layered memory is active.');
            invalidate(); return;
        }
        vectorController?.abort();
        const snapshot = snapshotNow(), metadata = snapshot.metadata, snapshotKey = key(snapshot), owner = state()?.owner, run = ++serial;
        const nodes = historyNodes(snapshot, state()?.history);
        if (!nodes?.length) { prepared = null; bridge()?.refreshInjection?.(); return; }
        const query = snapshot.chat.filter(m => !m.is_system).slice(-2).map(m => splitHint(m.mes).text).join('\n');
        const docs = candidates(nodes);
        let lemmas = {};
        if (globalThis.RussianWIForms?.getStatus?.().enabled && globalThis.RussianWIForms?.getLemmas) {
            try { lemmas = await globalThis.RussianWIForms.getLemmas([...new Set([query, ...docs.map(doc => doc.search)].flatMap(terms))]); }
            catch (error) { console.warn('[World Memory] Russian lemmas unavailable; using original words.', error); }
        }
        if (run !== serial || ctx().chatMetadata !== metadata) return;
        const lexical = rank(query, docs, lemmas);
        let ranked = lexical;
        vectorWarning = '';
        if (settings().historySemantic) {
            const abort = new AbortController(); let timeout;
            // A cold index may need several successful batches. Time out inactivity, not the entire build.
            const activity = () => { clearTimeout(timeout); timeout = setTimeout(() => abort.abort(), 120000); };
            activity();
            vectorController = abort;
            try {
                const semanticHits = await semantic(query, docs, owner, abort.signal, activity);
                // Reciprocal rank fusion: scores from unlike search systems are never compared directly.
                const scores = new Map(), byId = new Map(docs.map(doc => [doc.id, doc]));
                for (const list of [lexical, semanticHits]) list.forEach((doc, i) => scores.set(doc.id, (scores.get(doc.id) || 0) + 1 / (20 + i)));
                ranked = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id));
            } catch (error) { vectorWarning = error.message || 'Embeddings unavailable. Keyword search is active.'; }
            finally { clearTimeout(timeout); if (vectorController === abort) vectorController = null; }
        }
        const assembled = await assemble(nodes, ranked, { baseTokens: settings().historyBaseTokens, zoomTokens: settings().historyZoomTokens, countTokens });
        if (run !== serial || ctx().chatMetadata !== metadata || key(snapshotNow()) !== snapshotKey) return;
        prepared = { key: snapshotKey, text: assembled.text, selected: assembled.selected.map(doc => ({ kind: doc.kind, sourceIds: doc.sourceIds })), tokens: assembled.tokens };
        const output = document.getElementById('wm_history_status');
        if (output) output.textContent = [assembled.reason || `Chronological memory: ${assembled.tokens} tokens; ${assembled.selected.filter(d => d.kind === 'raw').length} original exchange(s) selected.`, vectorWarning].filter(Boolean).join(' ');
        bridge()?.refreshInjection?.();
    }
    function changed() { syncRegex(); syncHintPrompt(false); invalidate(); }
    const events = ctx().eventTypes || ctx().event_types;
    ctx().eventSource.makeFirst(events.MESSAGE_RECEIVED, onReply);
    for (const event of [events.CHAT_CHANGED, events.MESSAGE_EDITED, events.MESSAGE_SWIPED, events.MESSAGE_DELETED].filter(Boolean)) ctx().eventSource.on(event, changed);
    if (events.GENERATION_STOPPED) ctx().eventSource.on(events.GENERATION_STOPPED, invalidate);
    ctx().eventSource.on(events.GENERATION_ENDED, () => syncHintPrompt(false));
    globalThis.worldMemoryPrepareHistory = prepare;
    attach(); syncRegex();
    return { groupsFor, requestFields, accept, prune, changed, prepare,
        system: groups => groups.length ? HISTORY_PROMPT : '',
        pending: packet => settings().history && !packet.stale && packet.sources.length && state()?.history?.[packet.id]?.revision !== revision(packet),
        inspect: () => prepared ? { ...prepared, key: undefined } : null };
}
