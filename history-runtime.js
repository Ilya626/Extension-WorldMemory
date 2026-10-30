import { HINT_PROMPT, hash, splitHint, terms } from './history.js';
import { createEmbeddingVectorClient } from './embedding-vector-client.js';
import { createHistoryVectorRetrieval, HISTORY_VECTOR_CONTENT_REVISION } from './history-vector-retrieval.js';
import { archiveHistoryNodes, archiveStoryNodes, selectHistory } from './history-selection.js';
import { installHistoryInjection } from './history-injection.js';
import { semanticWIQuery } from './semantic-wi-runtime.js';

const REGEX_ID = 'world-memory-service-hint';
export function installHistory({ ctx, settings, state, saveState, status, bridge }) {
    let prepared = null, serial = 0, controller = null;
    const countTokens = text => ctx().getTokenCountAsync(text, 0);
    const embeddings = createEmbeddingVectorClient({ ctx,
        getConfig: () => ({ mode: settings().historyEmbeddingMode || 'api', api: settings().historyEmbeddingAPI || {},
            local: settings().historyEmbeddingLocal || {}, contentRevision: HISTORY_VECTOR_CONTENT_REVISION }), getSummaryConfig: settings });
    let search = createHistoryVectorRetrieval({ embeddings, countTokens });
    const tokenizerKey = () => {
        const c = ctx(); let nativeFlags;
        try { nativeFlags = [globalThis.sessionStorage?.getItem('tokenizationWarningShown'),
            globalThis.sessionStorage?.getItem('tokenizationSupported')]; } catch { /* Storage may be unavailable. */ }
        return JSON.stringify([c.mainApi, c.powerUserSettings?.tokenizer, c.powerUserSettings?.token_padding,
            c.getTokenizerModel?.(), c.onlineStatus, nativeFlags]);
    };
    let chunkTokenizer = tokenizerKey();
    const snapshot = () => bridge()?.snapshot?.();
    const profileId = () => { try { return embeddings.profile().id; } catch { return 'unconfigured'; } };
    const key = view => JSON.stringify([view.chatId, view.packets.map(p => [p.id, p.textRevision, p.sourceFingerprints, p.stale,
        p.order, p.sources.map(source => [source.id, source.index, source.hidden, source.is_system, source.hint]),
        hash(JSON.stringify(p.memoryMetadata)), hash(JSON.stringify(p.storySpine)), p.manual]), view.chat.slice(-2).map(m => [m.is_user, m.is_system, m.mes]),
        settings().historyMaxTokens, settings().historySemantic, profileId(), tokenizerKey()]);
    const getText = () => { if (!settings().enabled || !prepared) return ''; const current = snapshot();
        return current && prepared.key === key(current) ? prepared.text || '' : ''; };
    const injection = installHistoryInjection({ ctx, settings, getText, onPromptSize: info => {
        const output = document.getElementById('wm_prompt_size');
        if (output) output.textContent = `Full prompt estimate: ${info.tokens ?? info.tokenCount ?? '?'} tokens (${info.estimator}). Target: ${settings().promptTargetTokens || 24000}. Provider usage may differ.`;
    } });
    function invalidate() { serial++; controller?.abort(); prepared = null; injection.clear(); }
    function syncHints(enabled = false) {
        ctx().setExtensionPrompt('world_memory_hint', enabled && settings().enabled && settings().injectionPosition !== -1 && settings().hints ? HINT_PROMPT : '', 1, 0, false, 0);
        const scripts = ctx().extensionSettings.regex ??= [], index = scripts.findIndex(script => script.id === REGEX_ID);
        if (settings().enabled && settings().hints) {
            const script = { id: REGEX_ID, scriptName: 'World Memory: hide service hint', findRegex: '/<memory_hint>[\\s\\S]*$/gi', replaceString: '',
                trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
            if (index < 0) scripts.push(script); else scripts[index] = script;
        } else if (index >= 0) scripts.splice(index, 1);
    }
    async function onReply(index) {
        if (!settings().enabled) return;
        const message = ctx().chat[Number(index)];
        if (!message || message.is_user || message.is_system) return;
        const parsed = splitHint(message.mes); if (!parsed.hint) return;
        message.mes = parsed.text; message.extra ??= {}; message.extra.worldMemoryHint = parsed.hint;
        const swipe = message.swipe_id;
        if (Number.isInteger(swipe)) {
            if (message.swipes?.[swipe] !== undefined) message.swipes[swipe] = parsed.text;
            if (message.swipe_info?.[swipe]) (message.swipe_info[swipe].extra ??= {}).worldMemoryHint = structuredClone(parsed.hint);
        }
        delete message.extra.token_count; invalidate();
    }
    async function prepare(processedChat, _size, _abort, type) {
        injection.capture(processedChat); syncHints(type !== 'quiet');
        if (!settings().enabled || settings().injectionPosition === -1 || type === 'quiet' || !snapshot()) { invalidate(); return; }
        if (chunkTokenizer !== tokenizerKey()) {
            // Keep reusable vectors; only the token-counted window boundaries
            // belong to the old game tokenizer/model.
            invalidate(); search = createHistoryVectorRetrieval({ embeddings, countTokens }); chunkTokenizer = tokenizerKey();
        }
        controller?.abort();
        const view = snapshot(), metadata = ctx().chatMetadata, snapshotKey = key(view), run = ++serial;
        const nodes = archiveHistoryNodes(view), storyNodes = archiveStoryNodes(view), query = semanticWIQuery(view.chat);
        if (!storyNodes.length) { prepared = null; injection.refresh(); return; }
        // This is pre-trimming visibility, not proof that an original survives
        // in the final native prompt. Warn, but never remove its saved coverage.
        const visible = new Set(view.chat.filter(m => !m.is_system).map(m => m.sc_message_id || m.extra?.sc_message_id || m.id));
        const nativeOverlap = storyNodes.some(node => node.sources.some(source => visible.has(source.id)));
        const abort = new AbortController(); controller = abort;
        // Edits/saves invalidate serial. Avoid cloning and hashing the entire
        // growing archive for every token-count or embedding progress callback.
        const isCurrent = () => run === serial && ctx().chatMetadata === metadata && ctx().chat === view.chat;
        const output = document.getElementById('wm_history_status');
        let timeout, warning = '', lemmas = {}, baseline;
        const activity = () => { clearTimeout(timeout); timeout = setTimeout(() => abort.abort(), 120000); };
        try {
            const template = settings().injectionTemplate || '{{summary}}';
            const selectionOptions = { storyNodes, nativeOverlap, targetTokens: settings().historyMaxTokens ?? 8000,
                countTokens, format: text => template.replace('{{summary}}', () => text) };
            // Reader chronology does not depend on retrieval or its network availability.
            baseline = await selectHistory(nodes, [], selectionOptions);
            if (!isCurrent() || key(snapshot()) !== snapshotKey) return;
            prepared = { key: snapshotKey, ...baseline }; injection.refresh();
            activity();
            if (globalThis.RussianWIForms?.getStatus?.().enabled && globalThis.RussianWIForms?.getLemmas) {
                try { lemmas = await globalThis.RussianWIForms.getLemmas([...new Set([query, ...nodes.flatMap(n => n.sources.map(s => s.text))].flatMap(terms))]); }
                catch { warning = 'Russian word forms unavailable; original words remain searchable.'; }
            }
            const args = { nodes, query, lemmas, signal: abort.signal, onActivity: activity, isCurrent,
                onProgress: progress => { if (isCurrent() && output) output.textContent = `Preparing search: ${progress.completed} / ${progress.total}. Unchanged vectors are reused.`; } };
            let ranked;
            try { ranked = await search.search({ ...args, semantic: Boolean(settings().historySemantic) }); }
            catch (error) { if (abort.signal.aborted) throw error; warning = `${error.message} Keyword search is active.`;
                ranked = await search.search({ ...args, semantic: false }); }
            const diagnostics = ranked.diagnostics;
            const assembled = await selectHistory(nodes, ranked, selectionOptions);
            if (!isCurrent() || key(snapshot()) !== snapshotKey) return;
            prepared = { key: snapshotKey, text: assembled.text, tokens: assembled.tokens, selected: assembled.selected,
                blocks: assembled.blocks, baselineTokens: assembled.baselineTokens, spineInfo: assembled.spineInfo,
                warning: assembled.warning, diagnostics };
            if (output) output.textContent = [assembled.reason || `Recovered history: ${assembled.tokens} estimated ST tokens; soft target ${assembled.targetTokens}. Raw tail is separate.`, assembled.warning, warning].filter(Boolean).join(' ');
            injection.refresh();
        } catch (error) {
            if (run !== serial || ctx().chatMetadata !== metadata) return;
            if (baseline && key(snapshot()) === snapshotKey) {
                prepared = { key: snapshotKey, ...baseline,
                    warning: [baseline.warning, `Retrieval unavailable: ${error.message}. Complete saved story baseline kept.`].filter(Boolean).join(' ') };
                injection.refresh();
                if (output) output.textContent = prepared.warning;
            } else {
                prepared = null; injection.clear();
                if (output) output.textContent = error.message;
            }
        } finally { clearTimeout(timeout); if (controller === abort) controller = null; }
    }
    const changed = () => { invalidate(); syncHints(false); };
    const events = ctx().eventTypes || ctx().event_types;
    ctx().eventSource.makeFirst(events.MESSAGE_RECEIVED, onReply);
    for (const event of [events.CHAT_CHANGED, events.MESSAGE_EDITED, events.MESSAGE_UPDATED, events.MESSAGE_SWIPED, events.MESSAGE_DELETED, events.GENERATION_STOPPED].filter(Boolean)) ctx().eventSource.on(event, changed);
    ctx().eventSource.on(events.GENERATION_ENDED, () => syncHints(false));
    globalThis.worldMemoryPrepareHistory = prepare; syncHints();
    return { embeddings, prepare, changed, refresh: injection.refresh, stop: invalidate, inspect: () => prepared ? { ...prepared, key: undefined } : null,
        groupsFor: async () => [], requestFields: () => ({}), accept: async () => {}, prune: async () => {}, system: () => '', pending: () => false };
}
