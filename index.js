import { VERSION, OWNER, SYSTEM, normalize, signature, entryMeta, fingerprint, packetSignature, sourceLabel,
    parseResult, ownedEntries, retainedFacts, detectManual, markGenerated, formatContent,
    readSummaryWI, evidenceRevision, compactRevision, retainedContent, SUMMARY_WI_SYSTEM } from './memory.js';
import { installHistory } from './history-runtime.js';
import { createArchive, importLegacyArchive, readArchive } from './archive-store.js';
import { archiveHistoryNodes, archiveStoryNodes, selectHistory } from './history-selection.js';
import { contextPolicy, recommendContextBudget, contextStatistics } from './context-budget.js';
import { planRawContext, blindZoneStart } from './vendor/summaryception/raw-context.js';
import { installArchiveRuntime } from './archive-runtime.js';
import { SUMMARY_PROMPT_KEYS, copyLegacyPrompt, rememberPromptOrigin, describePromptOrigin, resetSummaryPrompts } from './summary-prompt-settings.js';
import { countTextTokens, tokenCounterStatus } from './token-counter.js';
import { createSemanticWIRuntime } from './semantic-wi-runtime.js';
import { placeSceneProfiles, removeDuplicateProfiles, profileSignature } from './scene-wi.js';
import { createKnowledgeRuntime, ensureKnowledgeInstances, rebindKnowledgeIdentities } from './knowledge-runtime.js';
import { sourceId } from './vendor/summaryception/summary-sources.js';
import { installWorldInfoTracking, collectSummaryWorldInfo, summaryWorldInfoBudget, getSummaryWorldInfoSources, getSummaryWorldInfoSignal,
    chatWorldInfo, requireChatWorldInfo } from './vendor/summaryception/world-info-context.js';
import { populateProfileDropdown } from './vendor/summaryception/connectionutil.js';
import { restoreAutomaticGhosts } from './vendor/summaryception/context-control.js';
import { portableCard, portablePng, packCardBackup, unpackCardBackup } from './card-transfer.js';
import { collectSupportBundle } from './support-export.js';
import { prepareSupportImport, rebindCompleteBackup } from './support-import.js';
import { createWIDiffRuntime, DIFF_SYSTEM } from './wi-diff-runtime.js';
import { usesWIDiffs } from './wi-diff.js';
import { parseModelJson } from './model-json.js';

const defaults = { enabled: true, auto: true, wiDiffs: false, knowledgeBoundaries: false, awarenessGraph: false, alwaysMain: true, language: 'auto', targetTokens: 160,
    detailTokens: 4000, referenceTokens: 6000, responseTokens: 0, position: 4, depth: 2,
    history: true, hints: true, historySemantic: true, historySpineRerank: false, historyEmbeddingMode: 'api', wiSemantic: false, wiSemanticTopK: 6, wiSemanticThreshold: 0.45,
    historyMaxTokens: 12000, promptTargetTokens: 32000, retainedContextTokens: 8000, compressionTriggerTokens: 4000,
    contextReserveTokens: 4000, wiActivationTokens: 4000, wiActivationUnlimited: false,
    batchContextTokens: 24000, blindZoneExchanges: 1,
    ghostUserMessages: true, ghostAssistantMessages: true, reapplyGhostingOnSummary: false, pauseSummarization: false,
    connectionSource: 'default', connectionProfileId: '', summarizerStreaming: false, wiStreaming: false, summarizerResponseLength: 0,
    openaiUrl: '', openaiKey: '', openaiModel: '', openaiMaxTokens: 0, ollamaUrl: 'http://localhost:11434', ollamaModel: '', ollamaMaxTokens: 0,
    summaryLanguage: 'en', summaryCustomLanguage: '', summarizerWorldInfo: true, summarizerWorldInfoPercent: 20,
    injectionPosition: 0, injectionDepth: 1, injectionRole: 0, injectionScan: false, injectionTemplate: '[Earlier history]\n{{summary}}' };
let nativeWI, controller = null, busy = false, timer = null, currentUpdate = null;
let history, archiveRuntime, semanticWI, knowledgeRuntime, wiDiffRuntime;
let nativeReferenceScope = null;
let updateAuthorBook = null;
let restoringCardGame = false;
let cardRestoreTimer = null;
let budgetRenderSerial = 0, budgetRenderTimer, lastContextStatistics = null, nativePromptSize = null, wiSize = null, wiMeasurementSerial = 0;
let lastNativeWIScan = null;
const ctx = () => SillyTavern.getContext();
const bridge = () => archiveRuntime;
const hasSavedWI = packet => Boolean(packet.memoryMetadata?.wiDiff || Array.isArray(packet.memoryMetadata?.wi?.updates));
const wiAttemptRevision = packet => compactRevision(packet.memoryMetadata?.wiDiff
    ? [packetSignature(packet), packet.memoryMetadata.wiDiff, packet.memoryMetadata.wiContext || null]
    : [packetSignature(packet), packet.memoryMetadata?.wi || null, packet.memoryMetadata?.wiContext || null]);
const diffMode = (memory = state()) => usesWIDiffs(settings(), memory);
function diffStatus(memory = state()) {
    const diff = memory?.wiDiffState;
    if (!diff) return diffMode(memory) ? 'DIFF: новые изменения сначала сохраняются как предложение.' : 'Обычный WI: подготовленные изменения записываются сразу.';
    const count = diff.confirmed.claims.filter(claim => !claim.legacy && !claim.retired).length;
    return `DIFF этого чата закреплён сохранённым журналом; глобальная настройка не меняется. Подтверждено тезисов ${count}.${diff.pending ? ` Последнее предложение: +${diff.pending.add.length} / −${diff.pending.remove.length}; ждёт следующего блока или явной проверки.` : ' Непроверенных предложений нет.'}`;
}
function wiCoverage(memory) {
    const packets = Object.values(memory?.archive?.records || {}).filter(packet => !packet.deleted);
    const prepared = packets.filter(hasSavedWI);
    const empty = prepared.filter(packet => packet.memoryMetadata.wiDiff
        ? !packet.memoryMetadata.wiDiff.add.length && !packet.memoryMetadata.wiDiff.remove.length : !packet.memoryMetadata.wi.updates.length).length;
    const applied = packets.filter(packet => memory?.wiPackets?.[packet.id]?.status === 'applied').length;
    const savedResponses = packets.filter(packet => packet.annotationResponse).length;
    return `WI по сохранённым L0: подготовлено ${prepared.length} / ${packets.length}, из них пустых ${empty}; применено ${applied}. Без результата WI: ${packets.length - prepared.length}.${savedResponses ? ` Ответов для проверки: ${savedResponses}; кнопки повторного разбора и диагностики находятся на основной панели.` : ''}`;
}
function renderWIProblem(memory = state()) {
    const output = document.getElementById('wm_wi_problem'); if (!output) return;
    const records = Object.values(memory?.archive?.records || {}).filter(record => !record.deleted);
    const missing = records.filter(record => !hasSavedWI(record)).length;
    const failures = records.filter(record =>
        record.annotationResponse && (record.annotationError || record.annotationResponse.error));
    output.hidden = !failures.length && !missing;
    output.textContent = [missing ? `Без подготовленного WI: ${missing} блок(ов) истории. «Подготовить недостающее» вызывает модель; «Повторить разбор» и «Apply saved WI» только используют уже полученные ответы.` : '',
        failures.length ? `Замечания к подготовке: ${failures.length}. ${failures[0].annotationError || failures[0].annotationResponse.error} Целые секции сохранены; результат записи WI указан отдельно.` : ''].filter(Boolean).join('\n');
}
const status = text => {
    const node = document.getElementById('wm_status');
    const memory = state(), pending = Object.values(memory?.wiPackets || {}).filter(item => item.status === 'error' || item.status === 'stale');
    const destination = memory?.book ? `Книга результата: ${memory.book}.` : 'Книга результата ещё не создана.';
    const receipt = pending.length ? `WI не применён: ${pending[0].message}`
        : memory?.lastWIWrite ? `Подтверждено на диске · записей WorldMemory: ${memory.lastWIWrite.records}.` : '';
    if (node) node.textContent = pending.length ? `${text}\n${receipt}` : text;
    for (const feedback of document.querySelectorAll('.wm-wi-feedback')) feedback.textContent = `${text}\n${destination} ${receipt}\n${wiCoverage(memory)}`;
    renderWIProblem(memory);
    const diffOutput = document.getElementById('wm_diff_status'); if (diffOutput) diffOutput.textContent = diffStatus(memory);
    renderBusy();
};
const settings = () => {
    const value = ctx().extensionSettings[OWNER] ??= {};
    if (value.archiveConfigVersion && value.wiActivationUnlimited === undefined) {
        // Preserve pre-existing native WI choices on upgrade; recommendations are explicit.
        value.wiActivationUnlimited = !(nativeWI?.world_info_budget_cap > 0);
        value.wiActivationTokens = nativeWI?.world_info_budget_cap > 0 ? nativeWI.world_info_budget_cap : 4000;
    }
    if (!value.archiveConfigVersion) {
        const historyWasDisabled = value.history === false && value.injectionPosition === undefined;
        const previous = ctx().extensionSettings.summaryception || {};
        for (const key of ['retainedContextTokens','batchContextTokens','blindZoneExchanges','ghostUserMessages','ghostAssistantMessages',
            'reapplyGhostingOnSummary','pauseSummarization','connectionSource','connectionProfileId','summarizerStreaming','summarizerResponseLength',
            'openaiUrl','openaiKey','openaiModel','openaiMaxTokens','ollamaUrl','ollamaModel','ollamaMaxTokens','summaryLanguage','summaryCustomLanguage',
            'summarizerWorldInfo','summarizerWorldInfoPercent','summarizerSystemPrompt','summarizerUserPrompt','stripPatterns',
            'injectionPosition','injectionDepth','injectionRole','injectionScan','injectionTemplate']) {
            if (SUMMARY_PROMPT_KEYS.includes(key)) copyLegacyPrompt(value, previous, key);
            else if (value[key] === undefined && previous[key] !== undefined) value[key] = structuredClone(previous[key]);
        }
        value.historyMaxTokens ??= value.historyBaseTokens !== undefined || value.historyZoomTokens !== undefined
            ? (Number(value.historyBaseTokens) || 4000) + (Number(value.historyZoomTokens) || 4000) : defaults.historyMaxTokens;
        if (historyWasDisabled) value.injectionPosition = -1;
        value.archiveConfigVersion = 1;
    }
    for (const [key, initial] of Object.entries(defaults)) if (value[key] === undefined) value[key] = initial;
    return value;
};
function state() {
    if (!ctx().chatId) return null;
    const value = ctx().chatMetadata[OWNER] ??= { owner: crypto.randomUUID(), chatId: ctx().chatId, packets: {}, mainNames: [] };
    value.packets ??= {}; value.mainNames ??= []; value.wiPackets ??= {};
    if (value.chatId !== ctx().chatId) {
        // A branch or renamed chat gets an independent book; no cross-chat write-through.
        value.cloneFrom = value.book || value.cloneFrom;
        value.cloneOwner = value.book ? value.owner : value.cloneOwner;
        value.book = null; value.owner = crypto.randomUUID(); value.chatId = ctx().chatId;
    }
    return value;
}
const saveState = () => ctx().saveMetadata();
function getArchive() {
    const memory = state(); if (!memory) return createArchive();
    memory.archive ??= createArchive();
    const legacy = ctx().chatMetadata.summaryception;
    for (const message of ctx().chat) sourceId(message);
    if (legacy?.layers && !Object.hasOwn(memory.archive.legacy, 'summaryception')) {
        importLegacyArchive(memory.archive, legacy);
        const present = new Set(ctx().chat.map(message => sourceId(message)));
        for (const record of Object.values(memory.archive.records)) record.unavailableSourceIds =
            record.sourceMessageIds.filter(id => !present.has(id));
    }
    // A legacy source absent on import is summary-only, not a newly deleted
    // source. Once it has reappeared, later removal is a real stale-source edit.
    const present = new Set(ctx().chat.map(message => sourceId(message)));
    for (const record of Object.values(memory.archive.records)) if (record.unavailableSourceIds?.length) {
        record.unavailableSourceIds = record.unavailableSourceIds.filter(id => !present.has(id));
    }
    return memory.archive;
}
async function saveArchive({ context = ctx(), signal } = {}) {
    const metadata = context.chatMetadata, chat = context.chat;
    const check = () => {
        signal?.throwIfAborted();
        if (ctx().chatMetadata !== metadata || ctx().chat !== chat) throw new Error('Chat changed. Saved memory belongs to the previous chat.');
    };
    check(); await context.saveMetadata(); check(); await context.saveChat(); check();
}
async function claimArchiveRuntime() {
    if (!settings().enabled) return false;
    const extensions = await import('/scripts/extensions.js');
    const previous = extensions.findExtension('Extension-Summaryception') || extensions.findExtension('Summaryception');
    if (!previous?.enabled) return false;
    // Disabling the extension removes its event handlers after reload. Its
    // settings, chat metadata and native manual context state remain intact.
    archiveRuntime?.stop();
    if (ctx().chatId) await saveArchive();
    status('Archive imported. Reloading once to disable the old Summaryception runtime.');
    await extensions.disableExtension(previous.name);
    return true;
}
const tokens = text => countTextTokens(text, ctx());
const names = value => [...new Set(value.split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
function unchanged(metadata) {
    controller?.signal.throwIfAborted();
    if (ctx().chatMetadata !== metadata) throw new Error('Chat changed. The result was not written to the new chat.');
    if (updateAuthorBook !== null && chatWorldInfo(ctx()) !== updateAuthorBook)
        throw new Error('The chat WI selection changed. The result was not written; retry with the current linked book.');
}
async function writeNativeBook(name, book, check = () => {}) {
    check();
    const expected = signature(book);
    await nativeWI.saveWorldInfo(name, book, true);
    check();
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name }) });
    check();
    const saved = response.ok ? await response.json() : null;
    check();
    if (!saved || signature(saved) !== expected) {
        nativeWI.worldInfoCache?.delete(name);
        throw new Error(`WI was not confirmed on disk: ${name}${response.ok ? '' : ` (HTTP ${response.status})`}. Saved L0 is kept; retry the saved WI result.`);
    }
    return saved;
}
async function adoptSelectedBook(memory, name) {
    const context = ctx(), oldName = memory.book || memory.cloneFrom, oldOwner = memory.cloneOwner || memory.owner;
    const check = () => {
        controller?.signal.throwIfAborted();
        if (ctx().chatMetadata !== context.chatMetadata || ctx().chat !== context.chat || state() !== memory
            || (memory.book || memory.cloneFrom) !== oldName || chatWorldInfo(ctx()) !== name)
            throw new Error('Chat or selected WI changed during transfer. Previous memory was kept.');
    };
    const target = await nativeWI.loadWorldInfo(name); check();
    if (!target?.entries) throw new Error(`Selected WI is missing: ${name}. Choose an existing book; no other book was substituted.`);
    const old = oldName ? await nativeWI.loadWorldInfo(oldName) : null; check();
    if (oldName && !old?.entries) throw new Error(`Previous memory book is missing: ${oldName}. Restore it before transferring its records.`);
    const next = structuredClone(target), uidMap = {}, used = new Set();
    for (const entry of ownedEntries(old, oldOwner)) {
        const meta = entryMeta(entry);
        const existing = ownedEntries(next, memory.owner).find(row => !used.has(row.uid)
            && (meta.knowledgeInstance ? entryMeta(row).knowledgeInstance === meta.knowledgeInstance
                : normalize(row.comment) === normalize(entry.comment) && entryMeta(row).type === meta.type));
        const uid = existing?.uid ?? nativeWI.createWorldInfoEntry(name, next)?.uid;
        if (uid === undefined) throw new Error('ST could not allocate a WI UID during transfer. Previous memory was kept.');
        used.add(uid); uidMap[entry.uid] = uid;
        if (existing && detectManual(existing)) continue;
        next.entries[uid] = { ...structuredClone(entry), uid };
        entryMeta(next.entries[uid]).owner = memory.owner;
    }
    await writeNativeBook(name, next, check); check();
    // Commit the pointer only after the target really exists on disk. Old book is retained.
    memory.book = name; delete memory.cloneFrom; delete memory.cloneOwner;
    if (oldName) {
        rebindKnowledgeIdentities(memory.archive, { book: old, world: oldName, owner: oldOwner },
            { book: next, world: name, owner: memory.owner }, uidMap);
        for (const record of Object.values(memory.archive?.records || {})) {
            const stamp = record.memoryMetadata?.wiContext;
            if (stamp?.owner !== oldOwner || stamp.book !== oldName) continue;
            stamp.owner = memory.owner; stamp.book = name;
            stamp.referenceUIDs = (stamp.referenceUIDs || []).map(uid => uidMap[uid] ?? uid);
            stamp.entryRevisions = Object.fromEntries(Object.entries(stamp.entryRevisions || {}).map(([uid, revision]) => [uidMap[uid] ?? uid, revision]));
            for (const update of record.memoryMetadata?.wi?.updates || []) if (update.uid !== null && uidMap[update.uid] !== undefined) update.uid = uidMap[update.uid];
        }
        for (const packet of bridge().snapshot().packets) if (memory.wiPackets?.[packet.id]?.status === 'applied')
            memory.wiPackets[packet.id].revision = compactRevision([packetSignature(packet), packet.memoryMetadata?.wi || null, packet.memoryMetadata?.wiContext || null]);
    }
    memory.lastWIWrite = { book: name, records: ownedEntries(next, memory.owner).length, at: Date.now() };
    await saveState();
}
async function getBook(create = false) {
    const memory = state();
    if (!memory) throw new Error('Open a character chat first.');
    const selected = chatWorldInfo(ctx());
    if (create && selected && memory.book !== selected) await adoptSelectedBook(memory, selected);
    if (!memory.book && !create) return null;
    if (!memory.book) {
        const metadata = ctx().chatMetadata, chat = ctx().chat, owner = memory.owner;
        const check = () => {
            if (ctx().chatMetadata !== metadata || ctx().chat !== chat || state() !== memory || memory.owner !== owner)
                throw new Error('Chat changed while copying the memory book.');
        };
        const name = `WorldMemory_${memory.owner}`;
        await nativeWI.createNewWorldInfo(name, { interactive: false });
        check();
        let data = memory.cloneFrom ? await nativeWI.loadWorldInfo(memory.cloneFrom) : null;
        check();
        data = data ? structuredClone(data) : { entries: {} };
        const oldBook = memory.cloneFrom, oldData = structuredClone(data);
        const owners = [...new Set(Object.values(data.entries || {}).map(entry => entryMeta(entry)?.owner).filter(Boolean))];
        const oldOwner = memory.cloneOwner || (owners.length === 1 ? owners[0] : null);
        if (memory.cloneFrom) {
            for (const [id, entry] of Object.entries(data.entries || {})) {
                if (entryMeta(entry)) entryMeta(entry).owner = memory.owner;
            }
        }
        memory.book = name; delete memory.cloneFrom;
        await nativeWI.saveWorldInfo(name, data, true);
        check();
        if (oldBook && oldOwner) {
            rebindKnowledgeIdentities(memory.archive,
                { book: oldData, world: oldBook, owner: oldOwner }, { book: data, world: name, owner: memory.owner });
            for (const record of Object.values(memory.archive?.records || {})) {
                const stamp = record.memoryMetadata?.wiContext;
                if (stamp?.owner === oldOwner && stamp.book === oldBook) {
                    stamp.owner = memory.owner; stamp.book = name;
                }
            }
        }
        delete memory.cloneOwner;
        await saveState();
    }
    const bookName = memory.book;
    const data = await nativeWI.loadWorldInfo(bookName);
    if (!data) throw new Error(`World Memory book is missing: ${memory.book}. Import its backup or choose a new chat.`);
    const book = structuredClone(data);
    if (settings().knowledgeBoundaries && ensureKnowledgeInstances(book, memory.owner)) {
        const name = bookName;
        if (state() !== memory || memory.book !== name) throw new Error('Chat changed while preparing character identities.');
        await nativeWI.saveWorldInfo(name, book, true);
        if (state() !== memory || memory.book !== name) throw new Error('WI book changed while preparing character identities.');
    }
    return book;
}
async function saveBook(book, metadata, baseBook = null) {
    const context = ctx(), memory = state(), name = memory?.book, owner = memory?.owner;
    const check = () => {
        unchanged(metadata);
        if (!memory || !name || ctx().chat !== context.chat || state() !== memory || memory.book !== name || memory.owner !== owner) {
            throw new Error('The receiving WI book changed. The result was not written to another book.');
        }
    };
    check();
    if (baseBook) {
        const current = await getBook();
        check();
        for (const [uid, live] of Object.entries(current.entries)) {
            if (entryMeta(live)?.owner !== state().owner || detectManual(live)) {
                const proposed = entryMeta(book.entries[uid]);
                const previous = entryMeta(baseBook.entries[uid]);
                // Keep the user's text and fields, but still unlink deleted source contributions.
                if (proposed && previous && entryMeta(live)?.owner === state().owner) {
                    for (const id of Object.keys(previous.contributions || {})) {
                        if (!proposed.contributions[id]) delete entryMeta(live).contributions[id];
                    }
                }
                book.entries[uid] = live;
            }
        }
        for (const uid of Object.keys(baseBook.entries)) {
            if (!current.entries[uid]) delete book.entries[uid];
        }
    }
    check();
    const saved = await writeNativeBook(name, book, check);
    memory.lastWIWrite = { book: name, records: ownedEntries(saved, owner).length, at: Date.now() };
    await context.saveMetadata();
    check();
    return book;
}
function initializeEntry(book, name, type = 'lore', main = false) {
    const entry = nativeWI.createWorldInfoEntry(state().book, book);
    if (!entry) throw new Error('ST could not allocate a World Info UID.');
    Object.assign(entry, { comment: name, key: [name], content: '', constant: main && settings().alwaysMain,
        position: settings().position, depth: settings().depth, role: 0, order: main ? 220 : 180,
        probability: 100, useProbability: true, excludeRecursion: true, preventRecursion: true });
    entry.extensions ??= {};
    entry.extensions[OWNER] = { owner: state().owner, type, main, contributions: {}, manual: false,
        ...(type === 'character' ? { knowledgeInstance: crypto.randomUUID() } : {}) };
    markGenerated(entry);
    return entry;
}
function syncMainNames(book) {
    const entries = ownedEntries(book, state().owner);
    for (const name of state().mainNames) {
        let entry = entries.find(item => normalize(item.comment) === normalize(name));
        if (!entry) { entry = initializeEntry(book, name, 'character', true); entries.push(entry); }
        const manual = detectManual(entry);
        const meta = entryMeta(entry); meta.type = 'character'; meta.main = true;
        if (!manual) { entry.constant = settings().alwaysMain; markGenerated(entry); }
    }
}
async function injectBook(payload) {
    // Imported copies use their own books even if an original is still globally
    // selected. Keep the user's global selection unchanged for every other chat.
    const importedBooks = ctx().chatMetadata.worldMemoryImport?.books;
    if (importedBooks) for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const entries = payload[key];
        if (Array.isArray(entries)) entries.splice(0, entries.length, ...entries.filter(entry =>
            !Object.hasOwn(importedBooks, entry.world) || importedBooks[entry.world] === entry.world));
    }
    if (getSummaryWorldInfoSources() !== null) return;
    const memory = state();
    if (!settings().enabled || !memory) return;
    if (!memory.book && memory.cloneFrom) await getBook(true);
    if (state() !== memory || !memory.book) return;
    const metadata = ctx().chatMetadata, world = memory.book;
    const scope = nativeReferenceScope;
    if (scope && !scope.signal?.aborted && scope.metadata === ctx().chatMetadata) {
        // Author-reference collection already has a separate managed-record
        // catalogue. Exclude our book BEFORE native groups and token budgeting.
        for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
            const entries = payload[key];
            if (Array.isArray(entries)) entries.splice(0, entries.length, ...entries.filter(entry => entry.world !== scope.book));
        }
        return;
    }
    await cleanupSourceChanges();
    const book = await getBook();
    if (ctx().chatMetadata !== metadata || state()?.book !== world) return;
    // ST may have loaded our book before the local cleanup completed.
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
        const entries = payload[key];
        if (Array.isArray(entries)) entries.splice(0, entries.length, ...entries.filter(entry => entry.world !== world));
    }
    const present = new Set(['globalLore', 'characterLore', 'chatLore', 'personaLore']
        .flatMap(key => payload[key] || []).map(entry => `${entry.world}.${entry.uid}`));
    for (const entry of Object.values(book.entries || {})) {
        if (entryMeta(entry)?.owner && entryMeta(entry).owner !== state().owner) continue;
        if (!entry.content?.trim() || present.has(`${world}.${entry.uid}`)) continue;
        payload.chatLore.push({ ...structuredClone(entry), world });
    }
}

async function model(systemPrompt, prompt, metadata) {
    unchanged(metadata);
    let timeout;
    const idleSeconds = settings().wiStreaming ? 120 : 300;
    const activity = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller?.abort(new Error(`No response data for ${idleSeconds} seconds. Saved WI was kept.`)), idleSeconds * 1000);
    };
    activity();
    try {
        const result = await bridge().request(systemPrompt, prompt, { signal: controller.signal, onActivity: activity, responseTokens: settings().responseTokens });
        unchanged(metadata);
        const updates = parseResult(result.text);
        updates.historyResponse = result.text;
        return updates;
    } finally { clearTimeout(timeout); }
}
async function sourceDetails(packet) {
    const chosen = []; let used = 0;
    for (const source of [...packet.sources].reverse()) {
        const text = `${source.name}: ${source.text}`;
        const size = await tokens(text);
        if (used + size > settings().detailTokens) continue;
        chosen.unshift({ index: source.index, name: source.name, text: source.text }); used += size;
    }
    return chosen;
}
async function requestPacket(packet, book, metadata) {
    const historyGroups = await history.groupsFor(packet);
    const entries = ownedEntries(book, state().owner);
    const included = new Set(), references = []; let used = 0;
    for (const entry of [...entries].sort((a, b) => Number(entryMeta(b).main) - Number(entryMeta(a).main))) {
        const row = { uid: entry.uid, name: entry.comment, facts: retainedFacts(entry, packet.id) };
        const size = await tokens(JSON.stringify(row));
        if (used + size > settings().referenceTokens) continue;
        references.push(row); included.add(entry.uid); used += size;
    }
    const language = { en: 'English', ru: 'Russian', auto: 'the language of the played source' }[settings().language];
    const prompt = { task: 'Extract contributions from this one saved L0 packet and update only the relevant references.',
        language, target_tokens_per_entry: settings().targetTokens, ...history.requestFields(historyGroups),
        main_characters: state().mainNames, player_name: bridge().snapshot().playerName,
        packet: { id: packet.id, order: packet.order, complete_saved_summary: packet.text, original_messages: historyGroups.length ? [] : await sourceDetails(packet),
            note: historyGroups.length ? 'history_groups contain ALL selected original messages, with exact addresses. They are also the source for WI extraction.' : 'The complete L0 summary covers the selected source set; original messages are optional detail, not unselected chat.' },
        existing_index: entries.map(entry => ({ uid: entry.uid, name: entry.comment, type: entryMeta(entry).type, keys: entry.key, manual: detectManual(entry) })),
        retained_evidence: references,
        instruction: 'Profiles for principal named actors in this packet are required. Explicit main names with no supported new facts may be omitted. Evidence order is the order field, not request position: the current packet may be earlier than retained facts. For an existing UID absent from retained_evidence, provide only the new facts; its full content will be rebuilt separately. Do not copy other records into current-packet facts.' };
    const updates = await model(SYSTEM + '\n' + history.system(historyGroups), JSON.stringify(prompt), metadata);
    await history.accept(packet, historyGroups, updates.historyResponse);
    return { updates, included };
}
async function fold(entries, metadata) {
    if (!entries.length) return new Map();
    status(`Rebuilding ${entries.length} records from their retained source contributions…`);
    const data = entries.map(entry => ({ uid: entry.uid, name: entry.comment, type: entryMeta(entry).type,
        main: entryMeta(entry).main, keys: entry.key, retained_evidence: retainedFacts(entry) }));
    const updates = await model(SYSTEM,
        JSON.stringify({ task: 'Rebuild the supplied existing records ONLY from retained_evidence. This is not a new story packet. Return their COMPLETE contents, empty facts, unchanged UIDs. Never restore omitted source contributions.',
            language: settings().language === 'ru' ? 'Russian' : settings().language === 'en' ? 'English' : 'Follow the evidence language',
            target_tokens_per_entry: settings().targetTokens, records: data }), metadata);
    const result = new Map(updates.filter(item => item.uid !== null).map(item => [item.uid, item.content]));
    for (const entry of entries) if (!result.has(entry.uid) || !result.get(entry.uid).trim()) {
        throw new Error(`No rebuilt text for ${entry.comment}. Existing WI was kept; retry Update memory.`);
    }
    return result;
}
function orderFor(entry, packets) {
    const ids = Object.keys(entryMeta(entry).contributions || {});
    const indices = ids.flatMap(id => packets.find(packet => packet.id === id)?.sources.map(source => source.index) || []);
    return indices.length ? Math.max(...indices) : null;
}
async function prepareSummaryContext({ sourceIds = [], existingSummary = null, signal } = {}) {
    if (!settings().enabled || !settings().auto || !bridge()?.snapshot) return null;
    if (diffMode()) {
        signal?.throwIfAborted();
        await update(false); signal?.throwIfAborted();
        const packet = bridge().snapshot({ effective: false }).packets.find(packet => packet.text === existingSummary
            && signature([...packet.sourceMessageIds].sort()) === signature([...sourceIds].sort()));
        const failed = Object.entries(state()?.wiPackets || {}).find(([id, item]) => id !== packet?.id
            && item.mode === 'diff' && item.status === 'error');
        if (failed) throw new Error(`Предыдущий DIFF не обработан: ${failed[1].message}`);
        const prepared = await wiDiffRuntime.prepare({ sourceIds, packetId: packet?.id });
        signal?.throwIfAborted(); return prepared;
    }
    const metadata = ctx().chatMetadata;
    let identity = null;
    const authorBook = chatWorldInfo(ctx());
    const guard = () => {
        signal?.throwIfAborted();
        if (ctx().chatMetadata !== metadata) throw new Error('Chat changed while preparing WI context.');
        if (chatWorldInfo(ctx()) !== authorBook) throw new Error('The chat WI selection changed while preparing references.');
        if (identity && (state()?.owner !== identity.owner || state()?.book !== identity.book)) throw new Error('The WI book changed while preparing references.');
    };
    try {
        guard();
        requireChatWorldInfo(ctx());
        // Commit previous saved tails before the next L0 request; this path never calls a model.
        await update(false); guard();
        if (busy) return null;
        identity = { owner: state().owner, book: state().book };
        const book = await getBook(true); guard();
        const snapshot = bridge().snapshot(), ids = new Set(sourceIds);
        const selected = snapshot.chat.flatMap((message, index) => ids.has(message.sc_message_id || message.extra?.sc_message_id) ? [{ message, index }] : []);
        const sourceKey = signature([...ids].sort());
        const previous = existingSummary === null ? null : snapshot.packets.find(packet => packet.text === existingSummary
            && signature([...packet.sourceMessageIds].sort()) === sourceKey);
        const omit = previous?.id || null, cue = normalize(selected.map(row => row.message.mes).join('\n'));
        const entries = ownedEntries(book, state().owner);
        const relevant = entry => [entry.comment, ...entry.key].some(key => normalize(key).length > 1 && cue.includes(normalize(key)));
        const ordered = [...entries].sort((a, b) => Number(entryMeta(b).main) - Number(entryMeta(a).main)
            || Number(relevant(b)) - Number(relevant(a)) || (orderFor(b, snapshot.packets) ?? -1) - (orderFor(a, snapshot.packets) ?? -1) || a.uid - b.uid);
        const index = entries.map(entry => ({ uid: entry.uid, name: entry.comment, type: entryMeta(entry).type,
            main: entryMeta(entry).main, manual: detectManual(entry), keys: entry.key }));
        const references = [], referenceUIDs = [], entryRevisions = {};
        for (const entry of entries) entryRevisions[entry.uid] = evidenceRevision(entry, omit);
        let used = await tokens(JSON.stringify(index)); guard();
        for (const entry of ordered) {
            const row = detectManual(entry)
                ? { uid: entry.uid, name: entry.comment, manual: true, readonly_content: entry.content }
                : { uid: entry.uid, name: entry.comment, retained_facts: retainedFacts(entry, omit).map(({ order, facts }) => ({ order, facts })) };
            const size = await tokens(JSON.stringify(row)); guard();
            if (used + size > settings().referenceTokens) continue;
            references.push(row); referenceUIDs.push(entry.uid); entryRevisions[entry.uid] = evidenceRevision(entry, omit); used += size;
        }
        const language = { en: 'English', ru: 'Russian', auto: 'the played source language' }[settings().language];
        let nativeReference = '';
        if (settings().summarizerWorldInfo && selected.length) {
            const originals = selected.map(({ message }) => `${message.name || 'Narrator'}: ${message.mes}`);
            const scope = { metadata, book: state().book, signal };
            nativeReferenceScope = scope;
            try {
                nativeReference = await collectSummaryWorldInfo(originals.join('\n\n'), existingSummary || '', {
                    maxTokens: summaryWorldInfoBudget(settings()), sourceMessages: originals,
                    signal,
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                status(`Native author WI was unavailable: ${error.message}. Managed references and saved L0 were kept.`);
            } finally {
                if (nativeReferenceScope === scope) nativeReferenceScope = null;
            }
            guard();
        }
        return { systemPrompt: SUMMARY_WI_SYSTEM,
            context: { language, target_tokens_per_entry: settings().targetTokens, main_characters: [...state().mainNames],
                player_name: snapshot.playerName, source_order: selected.length ? Math.min(...selected.map(row => row.index)) : null,
                existing_index: index, retained_evidence: references,
                native_world_info_readonly: nativeReference,
                instruction: 'The existing_index is the catalogue of managed records, including inactive ones: match existing subjects instead of creating duplicates. retained_evidence contains their prior played-source facts. native_world_info_readonly contains Constant/key-activated author lore selected by ST; use it as background and identity support, never as a newly played event or editable UID. Return current-packet contributions only in wi.updates[].facts. Merge retained_evidence and the current sources into concise entity references, not episode logs, respecting source order. Manual records are read-only. UIDs without retained_evidence receive facts only; prior evidence is preserved locally.' },
            stamp: { version: 1, owner: identity.owner, book: identity.book, authorBook, omittedPacketId: omit, referenceUIDs, entryRevisions } };
    } catch (error) {
        if (signal?.aborted) throw error;
        status(`WI context unavailable: ${error.message} L0 can still be saved. Retry saved WI or Update legacy WI.`);
        return null;
    }
}
function summaryRequest(packet, book) {
    const updates = readSummaryWI(packet.memoryMetadata?.wi);
    const authorBook = packet.memoryMetadata?.wiContext?.authorBook;
    if (authorBook !== undefined && authorBook !== chatWorldInfo(ctx()))
        throw new Error('Saved WI was prepared for a different chat-selected book. Retry metadata for the current binding.');
    const stamp = packet.memoryMetadata?.wiContext, included = new Set();
    if (stamp && (stamp.version !== 1 || stamp.owner !== state().owner || stamp.book !== state().book)) {
        throw new Error('Saved WI belongs to a different book revision. Refine this L0 or use Update legacy WI.');
    }
    if (!stamp && updates.some(update => update.uid !== null)) throw new Error('Saved WI has native UIDs without a book context. Refine this L0 or use Update legacy WI.');
    if (stamp && updates.some(update => update.uid !== null && !Object.hasOwn(stamp.entryRevisions || {}, update.uid))) {
        throw new Error('Saved WI selected a UID outside its supplied native index. Refine this L0 or use Update legacy WI.');
    }
    if (stamp?.version === 1 && stamp.owner === state().owner && stamp.book === state().book) {
        for (const entry of ownedEntries(book, state().owner)) if (stamp.referenceUIDs?.includes(entry.uid)
            && stamp.entryRevisions?.[entry.uid] === evidenceRevision(entry, packet.id)) included.add(entry.uid);
    }
    return { updates, included };
}
function clearUnprovenEntry(next, entry, keep = false) {
    if (entryMeta(entry).main || keep) { entry.content = ''; markGenerated(entry); }
    else delete next.entries[entry.uid];
}
async function applyPacket(packet, book, packets, metadata, savedWI = false) {
    if (diffMode()) throw new Error('Этот чат использует WI-DIFF; legacy-запись отключена. Подготовьте DIFF для нужного блока.');
    let { updates, included } = savedWI ? summaryRequest(packet, book) : await requestPacket(packet, book, metadata);
    unchanged(metadata);
    const current = bridge().snapshot().packets.find(item => item.id === packet.id);
    const sameRevision = live => live && packetSignature(live) === packetSignature(packet)
        && (!savedWI || compactRevision([live.memoryMetadata?.wi, live.memoryMetadata?.wiContext])
            === compactRevision([packet.memoryMetadata?.wi, packet.memoryMetadata?.wiContext]));
    if (!sameRevision(current)) throw new Error('The source packet or saved WI changed. Retry for the current saved revision.');
    // Work on a clone until all requested text is available; a failed request leaves the saved book intact.
    book = await getBook();
    if (savedWI) ({ updates, included } = summaryRequest(packet, book));
    const next = structuredClone(book);
    const previousSubjects = ownedEntries(next, state().owner).flatMap(entry => {
        const contribution = entryMeta(entry).contributions[packet.id];
        return contribution ? [{ uid: entry.uid, name: contribution.subjectName || entry.comment,
            type: contribution.subjectType || entryMeta(entry).type }] : [];
    });
    const affected = new Set(); const complete = new Map();
    const samePacket = state().packets[packet.id] === packetSignature(packet);
    const revisedUids = new Set(updates.filter(update => update.facts && update.uid !== null).map(update => update.uid));
    for (const entry of ownedEntries(next, state().owner)) {
        // Reapplying a packet must preserve a manual entry's existing provenance.
        // Actual source removal/invalidation is handled by removePackets.
        if (detectManual(entry)) continue;
        if (entryMeta(entry).contributions[packet.id] && (savedWI || !samePacket || revisedUids.has(entry.uid))) {
            delete entryMeta(entry).contributions[packet.id]; affected.add(entry.uid);
        }
    }
    for (const update of updates) {
        // A null UID must not create a second automatic profile over an explicitly manual subject.
        if (update.uid === null && ownedEntries(next, state().owner).some(entry => normalize(entry.comment) === normalize(update.name)
            && detectManual(entry))) continue;
        // Replaying a saved "new subject" update must reuse its own earlier
        // contribution instead of allocating another native UID on every retry.
        const previousSubject = update.uid === null ? previousSubjects.find(subject =>
            normalize(subject.name) === normalize(update.name) && subject.type === update.type) : null;
        let entry = update.uid === null ? next.entries[previousSubject?.uid] : next.entries[update.uid];
        if (entry && entryMeta(entry)?.owner !== state().owner) throw new Error('The model selected a foreign entry UID. No WI was written.');
        if (update.uid !== null && !entry) throw new Error(`Unknown WI UID ${update.uid}. No WI was written.`);
        if (entry && detectManual(entry)) continue;
        if (!update.facts) continue;
        const created = !entry;
        entry ??= initializeEntry(next, update.name, update.type, update.main);
        const meta = entryMeta(entry);
        const hasLaterEvidence = retainedFacts(entry, packet.id).some(fact => fact.order > packet.order);
        const currentIdentity = !savedWI || created || included.has(entry.uid) || !hasLaterEvidence;
        if (currentIdentity) meta.type = update.type;
        meta.main = meta.main || update.main || state().mainNames.some(name => normalize(name) === normalize(update.name));
        meta.contributions[packet.id] = { facts: update.facts, sourceMessageIds: [...packet.sourceMessageIds], order: packet.order,
            subjectName: update.name, subjectType: update.type,
            packetRevision: compactRevision(packetSignature(packet)) };
        if (currentIdentity) entry.comment = update.name;
        entry.key = savedWI ? [...new Set([...entry.key, ...update.keys])] : update.keys.length ? update.keys : [update.name];
        entry.constant = meta.main && settings().alwaysMain;
        // Later updates inspect this cloned book for manual collisions. Record
        // our own changes now, before another item can mistake them for edits.
        markGenerated(entry);
        affected.add(entry.uid);
        if ((created || included.has(entry.uid)) && (savedWI || !hasLaterEvidence) && update.content) complete.set(entry.uid, update.content);
    }
    const rebuild = [];
    for (const uid of affected) {
        const entry = next.entries[uid];
        if (!retainedFacts(entry).length) { clearUnprovenEntry(next, entry); continue; }
        if (!complete.has(uid)) rebuild.push(entry);
    }
    const rebuilt = savedWI ? new Map(rebuild.map(entry => [entry.uid, retainedContent(entry)])) : await fold(rebuild, metadata);
    for (const [uid, text] of rebuilt) complete.set(uid, text);
    for (const [uid, text] of complete) {
        const entry = next.entries[uid];
        entry.content = formatContent(entry.comment, text, orderFor(entry, packets)); markGenerated(entry);
    }
    const latest = bridge().snapshot().packets.find(item => item.id === packet.id);
    if (!sameRevision(latest)) throw new Error('The source packet or saved WI changed. Retry for the current saved revision.');
    const saved = await saveBook(next, metadata, book);
    state().packets[packet.id] = packetSignature(packet);
    await saveState();
    return saved;
}
async function removePackets(book, ids, packets, metadata, { local = false, preserveEmpty = false } = {}) {
    if (!ids.length) return book;
    const next = structuredClone(book), rebuild = [];
    for (const entry of ownedEntries(next, state().owner)) {
        const manual = detectManual(entry), meta = entryMeta(entry);
        const touched = ids.some(id => meta.contributions[id]);
        for (const id of ids) delete meta.contributions[id];
        if (!touched || manual) continue;
        if (!retainedFacts(entry).length) clearUnprovenEntry(next, entry, preserveEmpty);
        else rebuild.push(entry);
    }
    const rebuilt = local ? new Map(rebuild.map(entry => [entry.uid, retainedContent(entry)])) : await fold(rebuild, metadata);
    for (const entry of rebuild) { entry.content = formatContent(entry.comment, rebuilt.get(entry.uid), orderFor(entry, packets)); markGenerated(entry); }
    const saved = await saveBook(next, metadata, book);
    for (const id of ids) delete state().packets[id];
    await saveState();
    return saved;
}
async function cleanupSourceChanges() {
    const metadata = ctx().chatMetadata;
    // A source event can abort an earlier cleanup; still reconcile the new revision.
    if (currentUpdate) await currentUpdate.catch(() => {});
    if (ctx().chatMetadata !== metadata) return;
    await bridge()?.restoreStaleSources();
    if (ctx().chatMetadata !== metadata) return;
    await update(false, false, true);
}
function update(force = false, retrySaved = false, cleanupOnly = false) {
    if (busy) return currentUpdate || Promise.resolve();
    const running = runUpdate(force, retrySaved, cleanupOnly);
    currentUpdate = running;
    return running.finally(() => { if (currentUpdate === running) currentUpdate = null; });
}
async function runUpdate(force = false, retrySaved = false, cleanupOnly = false) {
    cleanupOnly ||= !force && !retrySaved && !settings().auto;
    if (busy || (!settings().enabled && !cleanupOnly)) return;
    if (!bridge()?.snapshot || (force && !bridge()?.request)) { status('Archive runtime is not ready. Reload ST.'); return; }
    if (force && bridge().isBusy()) {
        status('Memory or RP generation is busy. Wait for it to finish or press Stop.');
        return;
    }
    let snapshot = bridge().snapshot();
    const metadata = snapshot.metadata;
    if (!snapshot.chatId) { status('Open a character chat first.'); return; }
    if (force && diffMode()) { status('В режиме DIFF используйте подготовку поиска / WI. Последнее предложение проверяется отдельной кнопкой; legacy refresh не применяется к DIFF.'); return; }
    busy = true; controller = new AbortController(); renderBusy();
    try {
        updateAuthorBook = cleanupOnly ? null : requireChatWorldInfo(ctx());
        let book = await getBook(!cleanupOnly);
        if (!book) return;
        snapshot = bridge().snapshot();
        const diffManaged = diffMode();
        if (!cleanupOnly && !diffManaged) {
            const beforeNames = structuredClone(book); syncMainNames(book);
            book = await saveBook(book, metadata, beforeNames);
        }
        const current = new Set(snapshot.packets.map(packet => packet.id));
        await history.prune(snapshot);
        const tracked = new Set([...Object.keys(state().packets), ...ownedEntries(book, state().owner)
            .flatMap(entry => Object.keys(entryMeta(entry).contributions || {}))]);
        const removed = [...tracked].filter(id => !current.has(id));
        if (!diffManaged) book = await removePackets(book, removed, snapshot.packets, metadata, { local: !force });
        for (const id of Object.keys(state().wiPackets)) if (!current.has(id)) delete state().wiPackets[id];
        // A deleted/edited/regenerated source must stop contributing even if its optional replacement WI failed.
        const revised = snapshot.packets.filter(packet => tracked.has(packet.id) && (packet.stale
            || (state().packets[packet.id] && state().packets[packet.id] !== packetSignature(packet))
            || ownedEntries(book, state().owner).some(entry => {
                const saved = entryMeta(entry).contributions[packet.id]?.packetRevision;
                return saved && saved !== compactRevision(packetSignature(packet));
            }))).map(packet => packet.id);
        if (!diffManaged) book = await removePackets(book, revised, snapshot.packets, metadata, { local: true, preserveEmpty: true });
        else if (state().wiDiffState) { await wiDiffRuntime.materialize(); book = await getBook(); }
        const attemptSignature = wiAttemptRevision;
        for (const packet of snapshot.packets.filter(packet => packet.stale)) state().wiPackets[packet.id] = {
            revision: attemptSignature(packet), status: 'stale', message: 'Original sources changed. Regenerate the affected L0; old automatic contributions were removed.' };
        if (cleanupOnly) { await saveState(); return; }
        const pending = snapshot.packets.filter(packet => !packet.stale && (force
            || state().wiPackets[packet.id]?.revision !== attemptSignature(packet)
            || (retrySaved && !['applied', 'proposed', 'rejected'].includes(state().wiPackets[packet.id]?.status))));
        for (let i = 0; i < pending.length; i++) {
            unchanged(metadata); status(`Updating packet ${i + 1} / ${pending.length} · source ${sourceLabel(pending[i])}`);
            const packet = pending[i], revision = attemptSignature(packet);
            if (packet.memoryMetadata?.wiDiff) {
                try {
                    const previous = state().wiDiffState?.pending;
                    const result = await wiDiffRuntime.consume(packet);
                    recordDiffOutcome(packet, result, previous);
                    book = await getBook();
                } catch (error) {
                    unchanged(metadata);
                    state().wiPackets[packet.id] = { revision, status: 'error', mode: 'diff', message: error.message };
                    await saveState(); throw error;
                }
                await saveState(); continue;
            }
            if (diffManaged) {
                if (packet.memoryMetadata?.wiContext?.diff) state().wiPackets[packet.id] = {
                    revision, status: 'error', mode: 'diff', message: packet.annotationError
                        || 'DIFF не разобран. L0 и прежний WI сохранены. Повторите подготовку этого блока или разбор сохранённого ответа.' };
                else if (state().wiPackets[packet.id]?.revision !== revision) state().wiPackets[packet.id] = {
                    revision, status: 'pending', mode: 'diff', message: 'Сохранённый legacy WI не записывается поверх журнала DIFF. Подготовьте DIFF для этого блока.' };
                continue;
            }
            const saved = Boolean(packet.memoryMetadata?.wi);
            if (!saved && !force) {
                state().wiPackets[packet.id] = packet.memoryMetadata?.wiContext?.diff
                    ? { revision, status: 'error', mode: 'diff', message: packet.annotationError
                        || 'DIFF не разобран. L0 и прежний WI сохранены. Повторите подготовку этого блока или разбор сохранённого ответа.' }
                    : { revision, status: 'pending', message: 'No saved WI updates. Refine this L0 or use Update legacy WI.' };
                continue;
            }
            try {
                book = await applyPacket(packet, book, snapshot.packets, metadata, saved);
                state().wiPackets[packet.id] = { revision, status: 'applied', mode: saved ? 'saved-tail' : 'legacy-request' };
            } catch (error) {
                unchanged(metadata);
                if (force && saved) {
                    // Explicit legacy action may request a repair; automatic/saved retry never does.
                    status(`Saved WI could not be applied: ${error.message} Requesting the explicit legacy refresh…`);
                    book = await applyPacket(packet, book, snapshot.packets, metadata, false);
                    state().wiPackets[packet.id] = { revision, status: 'applied', mode: 'legacy-request' };
                } else if (force) throw error;
                else state().wiPackets[packet.id] = { revision, status: 'error', message: error.message };
            }
            await saveState();
        }
        unchanged(metadata);
        await saveState();
        const stale = snapshot.packets.filter(packet => packet.stale).length;
        const waiting = ownedEntries(book, state().owner).filter(entry => entryMeta(entry).main && !entry.content?.trim()).length;
        const historyErrors = Object.values(state().history || {}).filter(item => item.error).length;
        const wiPending = Object.values(state().wiPackets).filter(item => !['applied', 'proposed', 'rejected'].includes(item.status));
        const wiError = wiPending.find(item => item.status === 'error' || item.status === 'stale');
        status(stale ? `${stale} L0 packet(s) have changed sources. Their old automatic WI contributions were removed; regenerate those L0s.`
            : `Сохранено в ${state().book} · записей: ${ownedEntries(book, state().owner).length}, L0: ${Object.keys(state().packets).length}. ${diffManaged ? diffStatus() : 'Запись подтверждена на диске.'}${wiError ? ` Ошибка WI: ${wiError.message}` : wiPending.length ? ` Ожидают подготовки WI: ${wiPending.length} блоков; используйте Prepare search / WI.` : ''}${waiting ? ` ${waiting} main profile(s) await played evidence.` : ''}${historyErrors ? ` ${historyErrors} packet(s) need optional history markup; saved L0 is retained.` : ''}`);
    } catch (error) {
        if (cleanupOnly) throw error;
        console.error('[World Memory]', error);
        status(controller?.signal.aborted ? 'Stopped. Already saved packets were kept.' : error.message);
        if (!controller?.signal.aborted) toastr.warning(error.message, 'World Memory');
    } finally { updateAuthorBook = null; controller = null; busy = false; renderBusy(); await render(); }
}
function recordDiffOutcome(packet, result, previous) {
    const memory = state(), packets = bridge().snapshot({ effective: false }).packets;
    memory.wiPackets[packet.id] = { revision: wiAttemptRevision(packet), status: result.status, mode: 'diff' };
    memory.packets[packet.id] = packetSignature(packet);
    if (previous && memory.wiDiffState.lastReview?.proposalId === previous.id) {
        const prior = packets.find(item => item.id === previous.packetId);
        if (prior) memory.wiPackets[prior.id] = { revision: wiAttemptRevision(prior),
            status: memory.wiDiffState.lastReview.decision === 'accept' ? 'applied' : 'rejected', mode: 'diff' };
    }
}
async function reviewLastWIDiff({ savedOnly = false } = {}) {
    if (busy || !wiDiffRuntime || bridge().isBusy()) return;
    const metadata = ctx().chatMetadata, memory = state();
    if (!memory?.wiDiffState?.pending && !memory?.wiDiffReview?.responseText) { status('Нет предложения WI для проверки.'); return; }
    clearTimeout(timer); busy = true; controller = new AbortController(); renderBusy();
    try {
        updateAuthorBook = requireChatWorldInfo(ctx());
        let saved = savedOnly ? memory.wiDiffReview : null;
        if (!saved) {
            const prepared = await wiDiffRuntime.reviewContext(); unchanged(metadata);
            const prompt = JSON.stringify({ task: 'Explicitly review the last pending WI proposal. Return one memory_metadata block with wiDiff only; no new proposal.',
                world_memory_context: prepared.context, new_sources: [] });
            saved = memory.wiDiffReview = { packet: prepared.packet, systemPrompt: prepared.systemPrompt,
                userPrompt: prompt, status: 'requesting', responseText: '' };
            await saveState(); unchanged(metadata);
            status('Проверка последнего предложения WI · один запрос к модели.');
            const response = await bridge().request(prepared.systemPrompt, prompt, { signal: controller.signal,
                stage: 'wi-review', packetId: prepared.packet.id, responseTokens: settings().responseTokens });
            unchanged(metadata); saved.responseText = response.text; saved.status = 'received';
            await saveState(); unchanged(metadata);
        }
        if (!saved?.responseText) throw new Error('Нет сохранённого ответа для повторного разбора.');
        const parsed = parseModelJson(saved.responseText), wire = parsed.wiDiff || parsed;
        saved.packet.memoryMetadata.wiDiff = wire;
        const previous = memory.wiDiffState.pending;
        await wiDiffRuntime.consume(saved.packet); unchanged(metadata);
        // The synthetic review packet is a receipt, not an archive/history record.
        if (previous) {
            const prior = bridge().snapshot({ effective: false }).packets.find(item => item.id === previous.packetId);
            if (prior) memory.wiPackets[prior.id] = { revision: wiAttemptRevision(prior), status: wire.review.decision === 'accept' ? 'applied' : 'rejected', mode: 'diff' };
        }
        saved.status = 'applied'; saved.error = null; await saveState(); unchanged(metadata);
        history.changed(); status(`${wire.review.decision === 'accept' ? 'Предложение WI подтверждено и записано.' : 'Предложение отклонено; прежний WI сохранён.'} ${diffStatus()}`);
    } catch (error) {
        if (ctx().chatMetadata === metadata && state() === memory && memory.wiDiffReview) {
            memory.wiDiffReview.error = error.message; await saveState();
        }
        status(error.message);
    } finally { updateAuthorBook = null; controller = null; busy = false; renderBusy(); await render(); await renderArchive(); }
}
async function backfillSpine() {
    if (busy || !bridge() || bridge().isBusy()) return;
    clearTimeout(timer);
    try {
        const result = await bridge().backfillStorySpine({ responseTokens: settings().responseTokens,
            onProgress: p => status(`Preparing story skeleton ${p.saved + 1} / ${p.total} · ${p.sourceStatus === 'linked' ? 'original messages' : 'saved summary; originals unavailable'}`) });
        status(result.total ? `Prepared ${result.saved} story section(s), ${result.summaryOnly} from saved summaries. L0 text was kept.`
            : 'All eligible records already have a current story skeleton. Manual text and changed sources need your review.');
    } catch (error) {
        status(error.message); if (error.name !== 'AbortError') toastr.warning(error.message, 'World Memory');
    } finally { history.changed(); renderBusy(); await render(); await renderArchive(); }
}
async function backfillMetadata({ force = false, savedResponsesOnly = false } = {}) {
    if (busy) return;
    if (!bridge()?.backfillMemoryMetadata) { status('Archive runtime is not ready. Reload ST.'); return; }
    if (!ctx().chatId) { status('Open a character chat first.'); return; }
    if (bridge().isBusy()) { status('Wait for the active request or press Stop.'); return; }
    clearTimeout(timer);
    try {
        // The archive writer owns its reservation/controller. WI references can
        // still be prepared locally; they must not see a self-imposed WI busy.
        if (settings().auto && chatWorldInfo(ctx())) await getBook(true);
        const result = await bridge().backfillMemoryMetadata({ force, savedResponsesOnly, responseTokens: settings().responseTokens,
            onProgress: progress => status(`Подготовка поиска / WI: блок ${progress.saved + (progress.failed || 0) + 1} / ${progress.total} · ${progress.sourceStatus === 'summary-only' ? 'без исходников; новые WI не создаются' : 'полные исходные сообщения'}`) });
        status(result.total ? `${savedResponsesOnly ? 'Повторный разбор сохранённых ответов, без API. ' : ''}Сохранено блоков: ${result.saved} / ${result.total}; требуют проверки: ${result.warnings}; не разобрано: ${result.failed || 0}. L0 не менялся.`
            : savedResponsesOnly ? 'Нет сохранённых ошибочных ответов для повторного разбора. Запросов к API не было.' : 'All saved L0 packets already have current L′ / search metadata.');
    } catch (error) {
        const progress = error.metadataProgress;
        status(`${progress ? `Обработано ${progress.saved} / ${progress.total} блоков. Остановка на ${progress.packetId}; оставшиеся не обработаны. ` : ''}${error.message}`);
        if (error.name !== 'AbortError') toastr.warning(error.message, 'World Memory');
    } finally {
        history.changed();
        renderBusy(); await render(); await renderArchive();
    }
}
function schedule() {
    clearTimeout(timer);
    if (!settings().enabled || !settings().auto) return;
    timer = setTimeout(() => {
        if (busy) { schedule(); return; }
        void update();
    }, 900);
}
function renderBusy() {
    const working = busy || Boolean(archiveRuntime?.isBusy());
    $('#wm_update, #wm_retry_saved_wi, #wm_reparse_response, #wm_backfill_metadata, #wm_repeat_metadata, #wm_backfill_spine, #wm_summarize, #wm_card_wi').prop('disabled', working);
    $('#wm_archive button, #wm_import, #wm_export, #wm_card_save, #wm_card_load, #wm_card_resume, #wm_apply_recommended, #wm_reset_summary_prompts, #wm_enabled, #wm_clear_embeddings').prop('disabled', working);
    $('#wm_stop').prop('disabled', !working);
    $('#wm_coverage_prepare, #wm_coverage_apply, #wm_coverage_spine, .wm-coverage-mutation').prop('disabled', working);
    $('#wm_export_all, #wm_import_all').prop('disabled', working);
    $('#wm_wi_diffs').prop('checked', diffMode()).prop('disabled', working || Boolean(state()?.wiDiffState));
    $('#wm_update').prop('disabled', working || diffMode());
    $('#wm_review_diff').prop('disabled', working || !state()?.wiDiffState?.pending);
    $('#wm_retry_diff_review').prop('disabled', working || !state()?.wiDiffReview?.responseText || state()?.wiDiffReview?.status === 'applied');
    $('#wm_coverage_stop').prop('hidden', !working);
    const activity = document.getElementById('wm_coverage_working');
    if (activity) {
        activity.hidden = !working;
        activity.textContent = working ? `Обработка идёт. Сохранённые слои остаются доступны. ${document.getElementById('wm_status')?.textContent || ''}` : '';
    }
}
function button(text, callback) {
    const node = document.createElement('button'); node.className = 'menu_button'; node.textContent = text;
    node.addEventListener('click', () => Promise.resolve(callback()).catch(error => status(error.message))); return node;
}
let coverageFilter = 'all';
function coverageState(kind, label) { return { kind, label }; }
function coveragePacket(packet, memory) {
    const saved = memory.archive?.records?.[packet.id] || {}, meta = packet.memoryMetadata;
    const linked = packet.sourceStatus === 'linked', stale = packet.stale;
    const wi = hasSavedWI(packet), savedWI = hasSavedWI(saved), diff = meta?.wiDiff;
    const stamp = meta?.wiContext;
    const binding = !stamp || (stamp.version === 1 && stamp.owner === memory.owner && stamp.book === memory.book
        && (stamp.authorBook === undefined || stamp.authorBook === chatWorldInfo(ctx())));
    const revision = wiAttemptRevision(packet);
    const receipt = memory.wiPackets?.[packet.id];
    const currentReceipt = !stale && binding && receipt?.revision === revision;
    const applied = !stale && linked && binding && meta?.sourceStatus !== 'summary-only'
        && receipt?.status === 'applied' && receipt.revision === revision;
    const annotationWarning = Boolean(packet.annotationError || packet.annotationResponse?.error || packet.annotationStatus === 'partial');
    const l0 = coverageState(stale ? 'warn' : 'ok', stale ? 'L0 сохранён; исходники изменились' : packet.manual ? 'Сохранённый ручной L0' : 'L0 сохранён');
    const spine = stale ? coverageState('warn', 'Скелет требует проверки: исходники изменились')
        : packet.storySpine ? coverageState(packet.storySpine.sourceStatus === 'summary-only' ? 'warn' : 'ok',
            packet.storySpine.sourceStatus === 'summary-only' ? 'Скелет подготовлен по L0, без исходников' : 'Скелет L″ готов')
            : coverageState(packet.manual || packet.storySpineError ? 'warn' : 'pending', packet.manual ? 'Используется ручной L0 целиком'
                : packet.storySpineError || 'Нет L″; используется полный сохранённый L0');
    const search = stale ? coverageState('warn', 'Поиск требует обновления: исходники изменились')
        : meta?.lprime?.text ? coverageState(annotationWarning || !linked || meta.sourceStatus === 'summary-only' ? 'warn' : 'ok',
            !linked || meta.sourceStatus === 'summary-only' ? 'Поиск подготовлен по L0, без исходников'
                : annotationWarning ? 'Поиск доступен; есть замечание к разметке' : 'Поиск подготовлен')
            : coverageState(annotationWarning ? 'error' : 'pending', annotationWarning ? 'Поиск не подготовлен; ошибка разметки' : 'Поиск ещё не подготовлен');
    const prepared = stale ? coverageState('warn', 'WI требует обновления: исходники изменились')
        : wi ? coverageState(!linked || !binding || meta.sourceStatus === 'summary-only' ? 'warn' : 'ok', !linked ? 'WI сохранён; исходники недоступны'
            : meta.sourceStatus === 'summary-only' ? 'WI сохранён по L0, без исходного подтверждения'
            : !binding ? 'WI сохранён для другой привязки книги' : diff ? `DIFF подготовлен: +${diff.add.length} / −${diff.remove.length}`
                : meta.wi.updates.length ? `WI подготовлен: ${meta.wi.updates.length} изменений` : 'Проверено: новых фактов WI нет')
            : coverageState(!linked || savedWI ? 'warn' : annotationWarning ? 'error' : 'pending', !linked ? 'WI нужны исходники'
                : savedWI ? 'Сохранённый WI не соответствует текущему L0' : annotationWarning ? 'WI не подготовлен; проверьте ответ' : 'WI ещё не подготовлен');
    const written = applied ? coverageState('ok', diff ? 'DIFF проверен; подтверждённое состояние записано'
        : !wi ? 'WI записан через legacy; отдельный результат подготовки не сохранён'
        : meta.wi.updates.length ? 'Текущий результат WI записан' : 'Пустой результат применён; запись не нужна')
        : receipt?.status === 'error' ? coverageState('error', `Ошибка записи WI: ${receipt.message || 'причина не сохранена'}`)
            : stale || receipt?.status === 'stale' || (receipt?.status === 'applied' && !applied)
                ? coverageState('warn', 'Прежний статус записи WI не подтверждает текущую версию / книгу')
                : currentReceipt && receipt?.status === 'proposed' ? coverageState('pending', 'Предложение сохранено; ждёт следующего блока или явной проверки')
                    : currentReceipt && receipt?.status === 'rejected' ? coverageState('warn', 'Предложение отклонено; прежний WI сохранён')
                        : coverageState('pending', wi ? 'WI готов, но текущая запись не подтверждена' : 'WI ещё не записан');
    const cells = [l0, spine, search, prepared, written];
    return { packet, cells, linked, applied, wi, needsApply: wi && (!currentReceipt || !['applied', 'proposed', 'rejected'].includes(receipt?.status)), missing: prepared.kind !== 'ok',
        attention: cells.some(cell => cell.kind === 'warn' || cell.kind === 'error'), needsSpine: !stale && !packet.manual && !packet.storySpine };
}
function coverageRange(packet) {
    const indices = (packet.sources || []).map(source => source.index).filter(Number.isFinite).sort((a, b) => a - b);
    if (indices.length) return `#${indices[0]}–${indices.at(-1)}`;
    return Array.isArray(packet.turnRange) && packet.turnRange.every(Number.isFinite) ? `#${packet.turnRange[0]}–${packet.turnRange[1]}` : 'Без номеров';
}
function coverageSources(packet) {
    const indices = [...new Set((packet.sources || []).map(source => source.index).filter(Number.isFinite))].sort((a, b) => a - b);
    const ranges = [];
    for (let i = 0; i < indices.length; i++) {
        const start = indices[i]; let end = start;
        while (indices[i + 1] === end + 1) end = indices[++i];
        ranges.push(start === end ? `#${start}` : `#${start}–${end}`);
    }
    return ranges.join(', ') || 'Номера исходников недоступны';
}
function coverageDetails(row, metadata) {
    const { packet } = row, content = document.createElement('div'); content.className = 'wm-coverage-detail';
    for (const [index, heading] of ['Резюме L0', 'Скелет L″', 'Поиск', 'WI подготовлен', 'WI в книге'].entries()) {
        const line = document.createElement('div'), label = document.createElement('span'), value = document.createElement('b');
        line.className = 'wm-coverage-state'; label.textContent = heading; value.textContent = row.cells[index].label;
        line.append(label, value); content.append(line);
    }
    const source = document.createElement('p'); source.className = 'wm-muted';
    source.textContent = `Источники: доступны ${packet.sources.length} из ${packet.sourceMessageIds.length}. ${coverageSources(packet)}. ${packet.stale
        ? 'Состав или текст изменён; сохранённый L0 остаётся в архиве.' : !row.linked ? 'Часть исходников недоступна; подготовка по L0 отмечается отдельно.'
            : 'Поиск / WI используют связанные исходные сообщения.'} Номера сохранены как в чате, с нуля; интервал может содержать пропуски.`;
    content.append(source);
    for (const message of [packet.annotationError, packet.storySpineError]) if (message) {
        const note = document.createElement('p'); note.className = 'wm-muted'; note.textContent = message; content.append(note);
    }
    const actions = document.createElement('div'); actions.className = 'wm-actions';
    const action = (text, callback, mutation = true) => {
        const control = button(text, async () => {
            if (ctx().chatMetadata !== metadata) return;
            if (mutation && (busy || archiveRuntime.isBusy())) return;
            try { await callback(); }
            finally { if (mutation) { history.changed(); await render(); await renderArchive(); } }
        });
        if (mutation) control.classList.add('wm-coverage-mutation'); return control;
    };
    actions.append(action('Открыть L0 и действия в архиве', async () => {
        await renderArchive();
        const target = [...document.querySelectorAll('#wm_archive > details')].find(node => node.dataset.recordId === packet.id);
        if (!target) return;
        target.parentElement.closest('details').open = true; target.open = true; target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, false));
    if (!packet.stale) actions.append(action(!row.linked ? 'Подготовить поиск по L0 · модель'
        : row.wi ? 'Подготовить поиск / WI заново · модель' : 'Подготовить поиск / WI блока · модель',
        () => archiveRuntime.backfillMemoryMetadata({ packetId: packet.id, force: row.wi, responseTokens: settings().responseTokens })));
    if (packet.annotationResponse) actions.append(action('Повторить разбор ответа · 0 запросов',
        () => archiveRuntime.backfillMemoryMetadata({ packetId: packet.id, force: true, savedResponsesOnly: true, responseTokens: settings().responseTokens })));
    if (row.needsApply) actions.append(action('Обработать готовый WI · 0 запросов', () => update(false, true)));
    content.append(actions); return content;
}
function renderCoverage(snapshot = archiveRuntime?.snapshot({ effective: false })) {
    const container = document.getElementById('wm_coverage_rows'); if (!container || !snapshot) return;
    const memory = state(), rows = snapshot.packets.map(packet => coveragePacket(packet, memory));
    const sourceIds = new Set(snapshot.packets.flatMap(packet => packet.sources.map(source => source.id)));
    const missing = rows.filter(row => row.missing).length, attention = rows.filter(row => row.attention).length;
    const summary = document.getElementById('wm_coverage_summary');
    summary.textContent = `${rows.length} сохранённых L0 · ${sourceIds.size} связанных исходников. Скелет: ${rows.filter(row => row.packet.storySpine && !row.packet.stale).length}/${rows.length}. WI готов: ${rows.filter(row => row.cells[3].kind === 'ok').length}/${rows.length}; текущий WI в книге: ${rows.filter(row => row.applied).length}/${rows.length}.`;
    for (const control of document.querySelectorAll('[data-coverage-filter]')) {
        const name = control.dataset.coverageFilter;
        control.textContent = name === 'all' ? `Все ${rows.length}` : name === 'missing' ? `Без WI ${missing}` : `Замечания ${attention}`;
        control.setAttribute('aria-pressed', String(coverageFilter === name));
    }
    const opened = new Set([...container.querySelectorAll('details[open]')].map(node => node.dataset.recordId));
    container.replaceChildren();
    for (const row of rows.filter(row => coverageFilter === 'all' || (coverageFilter === 'missing' ? row.missing : row.attention))) {
        const panel = document.createElement('details'), title = document.createElement('summary'), range = document.createElement('span');
        panel.className = 'wm-coverage-record'; panel.dataset.recordId = row.packet.id; title.className = 'wm-coverage-row';
        const at = document.createElement('b'), count = document.createElement('small');
        at.textContent = coverageRange(row.packet); count.textContent = `${row.packet.sourceMessageIds.length} исходников`;
        range.className = 'wm-coverage-range'; range.append(at, count); title.append(range);
        title.setAttribute('aria-label', `${at.textContent}. ${row.cells.map(cell => cell.label).join('. ')}`);
        for (const cell of row.cells) {
            const mark = document.createElement('span'); mark.className = `wm-coverage-cell wm-coverage-${cell.kind}`;
            mark.textContent = cell.kind === 'ok' ? '✓' : cell.kind === 'pending' ? '—' : '!'; mark.title = cell.label; mark.setAttribute('aria-hidden', 'true'); title.append(mark);
        }
        panel.append(title);
        const expand = () => { if (panel.open && panel.childElementCount === 1) { panel.append(coverageDetails(row, snapshot.metadata)); renderBusy(); } };
        panel.addEventListener('toggle', expand); container.append(panel);
        if (opened.has(row.packet.id)) { panel.open = true; expand(); }
    }
    if (!container.childElementCount) {
        const empty = document.createElement('p'); empty.className = 'wm-muted';
        empty.textContent = rows.length ? 'Блоков с таким состоянием нет.' : 'Сохранённых L0 пока нет. Сырой хвост чата показан ниже.'; container.append(empty);
    }
    const wiEnabled = chatWorldInfo(ctx()) && settings().auto !== false;
    document.getElementById('wm_coverage_next').textContent = !rows.length ? 'Новые сообщения сначала сохраняются в L0.'
        : !wiEnabled ? 'Для подготовки WI выберите книгу этого чата и включите Prepare and apply WI. Без этого подготовка сохраняет поиск; архив и скелет остаются доступны.'
        : missing ? `Без подготовленного WI: ${missing} блок(ов). Замечание к поисковой цитате не отменяет готовый WI. Подготовка использует модель; число вызовов зависит от настроек.`
        : 'У всех блоков сохранён результат WI, включая успешные пустые результаты. Замечания и запись в текущую книгу показаны отдельно.';
    document.getElementById('wm_coverage_prepare').hidden = !rows.length;
    document.getElementById('wm_coverage_apply').hidden = !rows.some(row => row.needsApply);
    document.getElementById('wm_coverage_spine').hidden = !rows.some(row => row.needsSpine);
    renderBusy();
}
async function renderArchive() {
    const container = document.getElementById('wm_archive'), label = document.getElementById('wm_archive_status');
    if (!container || !archiveRuntime) return;
    const snapshot = archiveRuntime.snapshot({ effective: false });
    renderCoverage(snapshot);
    const records = snapshot.packets, stale = records.filter(record => record.stale);
    const incomplete = record => record.annotationStatus === 'pending' || record.annotationStatus === 'partial' || Boolean(record.annotationError);
    label.textContent = `${records.length} saved records · ${stale.length} changed source set(s) · ${records.filter(r => !r.storySpine && !r.manual && !r.stale).length} need a compact story skeleton · ${records.filter(incomplete).length} need search notes / WI. Archive size is independent of the history request target.`;
    container.replaceChildren();
    const metadata = ctx().chatMetadata;
    for (const record of records.slice().reverse()) {
        const panel = document.createElement('details'); panel.className = 'wm-record';
        panel.dataset.recordId = record.id;
        const title = document.createElement('summary');
        const linked = record.sources || [];
        const at = linked.length ? `messages ${linked[0].index}–${linked.at(-1).index}` : 'originals unavailable';
        const countSource = record.tokenCountSource || '';
        const countLabel = record.tokenCountOrigin === 'manual-tokenizer' || countSource.startsWith('estimated:') ? 'text estimate'
            : /^(?:usage\.|usageMetadata\.|eval_count$)/.test(countSource) ? 'API output tokens' : 'saved count; basis unknown';
        title.textContent = `${at} · ${record.tokenCount ?? '?'} (${countLabel})${record.manual ? ' · manual' : ''}${record.stale ? ' · SOURCES CHANGED' : ''}${record.storySpine ? ' · skeleton ready' : ' · full saved account'}${incomplete(record) ? ' · search notes / WI incomplete' : ''}`;
        title.title = [countSource, Number.isFinite(record.responseTokenCount)
            ? `Original response: ${record.responseTokenCount} (${record.responseTokenCountSource || 'source unknown'}); may include hidden output.` : ''].filter(Boolean).join('\n');
        panel.append(title);
        panel.addEventListener('toggle', () => {
            if (!panel.open || panel.childElementCount > 1) return;
            const text = document.createElement('textarea'); text.className = 'text_pole'; text.rows = 7; text.value = record.text;
            text.setAttribute('aria-label', `Saved memory ${record.id}`);
            const sourceDetails = document.createElement('details'), sourceTitle = document.createElement('summary'), sourceText = document.createElement('pre');
            sourceTitle.textContent = `${record.sourceMessageIds.length} exact source links`;
            sourceText.textContent = record.sourceMessageIds.map(id => {
                const source = linked.find(item => item.id === id);
                return source ? `#${source.index} · ${source.name} · ${id}` : `${id} · unavailable`;
            }).join('\n');
            sourceDetails.append(sourceTitle, sourceText);
            const actions = document.createElement('div'); actions.className = 'wm-actions';
            const action = (name, callback) => button(name, async () => {
                if (ctx().chatMetadata !== metadata) return;
                try { await callback(); history.changed(); }
                finally { await renderArchive(); renderBusy(); }
            });
            actions.append(action('Save text', () => archiveRuntime.edit(record.id, text.value)),
                action('Regenerate · 2 calls', () => archiveRuntime.regenerate(record.id)),
                action('Refine · 2 calls', () => archiveRuntime.refine(record.id)),
                action('Rebuild search notes / WI', () => archiveRuntime.backfillMemoryMetadata({ packetId: record.id, force: true })),
                action('Delete', () => archiveRuntime.remove(record.id)));
            if (!record.manual && !record.stale) actions.append(action(record.storySpine ? 'Rebuild story skeleton' : 'Prepare story skeleton',
                () => archiveRuntime.backfillStorySpine({ packetId: record.id, force: true, responseTokens: settings().responseTokens })));
            if (record.stale) {
                const warning = document.createElement('p'); warning.className = 'wm-muted';
                warning.textContent = 'The linked messages were edited or removed. This saved account is retained but excluded from retrieval until refreshed. Regenerate uses its exact remaining source set; missing originals need your review.';
                panel.append(warning);
            }
            if (record.annotationError) {
                const warning = document.createElement('p'); warning.className = 'wm-muted';
                warning.textContent = `Saved L0 kept. ${record.annotationError} Use Rebuild search notes / WI to retry this step only.`;
                panel.append(warning);
            }
            if (record.storySpineError) {
                const warning = document.createElement('p'); warning.className = 'wm-muted';
                warning.textContent = `Saved L0 kept. ${record.storySpineError}`; panel.append(warning);
            }
            panel.append(text, sourceDetails, actions); renderBusy();
        });
        container.append(panel);
    }
    renderBusy();
}
function renderWIStatus() {
    const output = document.getElementById('wm_wi_search_status'); if (!output) return;
    const scan = semanticWI?.inspect();
    output.textContent = !settings().wiSemantic ? 'Semantic WI search is off. Native keywords remain active.'
        : scan?.status === 'indexing' ? `Preparing WI embeddings: ${scan.completed} / ${scan.total}. Unchanged entries are reused.`
        : scan?.status === 'ready' ? `Last WI scan: ${scan.selected.length} semantic candidates. Native entry rules still apply.`
            : scan?.reason ? `Embedding search was unavailable${scan.error ? ': ' + scan.error : ''}. Native keywords remain active.` : 'Semantic WI will be prepared during the next WI scan.';
    if (lastNativeWIScan?.metadata === ctx().chatMetadata) {
        const entries = lastNativeWIScan.entries;
        output.textContent += ` Последний игровой скан ST выбрал ${entries.length}: ${entries.map(entry => `${entry.title || `#${entry.uid}`} (${entry.constant ? 'Constant' : 'условия ST'})`).join('; ') || 'нет записей'}. Это результат сканирования, не подтверждение доставки после окончательной обрезки ST.`;
        const scene = lastNativeWIScan.scene || [];
        if (scene.length) output.textContent += ` Профили сцены перед последним постом игрока: ${scene.map(entry => entry.title || `#${entry.uid}`).join('; ')}. Сохранённые позиции книги не меняются.`;
        if (lastNativeWIScan.duplicates?.length) output.textContent += ` Точные копии профилей из других книг вставлены один раз: ${lastNativeWIScan.duplicates.map(entry => entry.title || `#${entry.uid}`).join('; ')}. Различающиеся сведения сохранены.`;
    }
}
function applyNativeWIBudget() {
    const s = settings(); if (!s.enabled) return;
    const cap = s.wiActivationUnlimited ? 0 : Math.max(1, Number(s.wiActivationTokens) || 0);
    if (nativeWI.world_info_budget_cap !== cap) {
        nativeWI.updateWorldInfoSettings({ world_info_budget_cap: cap });
        $('#world_info_budget_cap, #world_info_budget_cap_counter').val(cap);
    }
}
function scheduleContextStatistics() {
    const run = ++budgetRenderSerial; clearTimeout(budgetRenderTimer);
    const s = settings(), policy = contextPolicy(s), maximum = document.getElementById('wm_raw_max');
    if (maximum) maximum.value = policy.rawMaximumTokens;
    const wiControl = document.getElementById('wm_wi_activation_tokens');
    if (wiControl) wiControl.disabled = policy.wiActivationUnlimited;
    budgetRenderTimer = setTimeout(() => { void renderContextStatistics(run).catch(error => {
        if (run === budgetRenderSerial) document.getElementById('wm_context_breakdown').textContent = `Context estimate unavailable: ${error.message}. Manual values are unchanged.`;
    }); }, 200);
}
async function renderContextStatistics(run) {
    const context = ctx(), metadata = context.chatMetadata, s = settings(), view = archiveRuntime?.snapshot({ effective: false });
    const current = () => run === budgetRenderSerial && ctx().chatMetadata === metadata && ctx().chat === context.chat;
    let rawPlan = {}, selected = { tokens: 0, baselineTokens: 0 }, protectedTokens = 0;
    if (view && context.chatId) {
        const archive = getArchive(), legacy = Object.values(archive.legacy || {});
        rawPlan = await planRawContext(context.chat, { layers: [readArchive(archive)],
            legacySourceIds: legacy.flatMap(store => store.legacySourceIds || []),
            skippedMessageIds: [...(archive.skippedMessageIds || []), ...legacy.flatMap(store => store.skippedMessageIds || [])] }, s, () => !current());
        if (!current()) return;
        const protectedText = context.chat.slice(blindZoneStart(context.chat, s)).filter(message => !message.is_system)
            .map(message => `${message.name || (message.is_user ? 'User' : 'Assistant')}: ${message.mes}`).join('\n');
        protectedTokens = protectedText ? await countTextTokens(protectedText, context) : 0;
        const prepared = history.inspect();
        selected = prepared || await selectHistory(archiveHistoryNodes(view), [], { storyNodes: archiveStoryNodes(view),
            targetTokens: s.historyMaxTokens, countTokens: text => countTextTokens(text, context),
            format: text => (s.injectionTemplate || '{{summary}}').replace('{{summary}}', () => text) });
    }
    if (!current()) return;
    const wiTokens = wiSize?.metadata === metadata ? wiSize.tokens : undefined;
    const observed = nativePromptSize?.metadata === metadata ? nativePromptSize.info : null;
    const stats = contextStatistics({ settings: s, rawPlan, history: selected, protectedTokens, wiTokens, nativePrompt: observed });
    lastContextStatistics = stats;
    const n = value => value === null || value === undefined ? '?' : Math.round(value).toLocaleString();
    const h = stats.history, p = stats.policy;
    document.getElementById('wm_history_capacity').textContent = `Полный L″ / сохранённая история: ≈${n(h.baselineTokens)} · Подробности: ≈${n(h.detailTokens)} · Свободно: ${n(h.freeTokens)} из ${n(h.budgetTokens)} токенов${h.topUpTokens ? ` · Стартовая квота ${n(h.configuredBudgetTokens)}; финальный добор +≈${n(h.topUpTokens)}` : ''}${h.overflowTokens ? ` · Превышение +${n(h.overflowTokens)}; весь скелет сохранён` : ''}${!history?.inspect() ? ' · до поиска подробностей' : ''}`;
    const finalProtected = observed?.finalTopUp?.protectedTokens ?? 0;
    const fill = observed?.finalTopUp;
    const fillStatus = { filled: 'выполнен', full: 'запрос уже заполнен', 'no-more-details': 'доступные подробности исчерпаны',
        'no-fitting-details': 'оставшиеся цельные подробности не помещаются', 'history-not-found': 'блок истории изменён или отсутствует в запросе',
        changed: 'сборка изменилась во время добора', unavailable: 'ошибка локальной сборки',
        'retrieval-unavailable': 'подготовка поиска не завершилась', 'unsupported-prompt': 'этот формат запроса не поддерживает добор' };
    const finalAccounted = stats.nativeObservedTokens === null ? null : Math.max(0, stats.nativeObservedTokens - finalProtected);
    const lines = [
        `План: история ${n(p.historyMaxTokens)} + хвост ${n(p.retainedContextTokens)} + рост до сжатия ${n(p.compressionTriggerTokens)} + WI ${p.wiActivationUnlimited ? 'без абсолютного лимита' : n(p.wiActivationTokens)} + резерв инструкций ${n(stats.fixed.estimatedTokens)} = ${n(stats.plannedTokens)} токенов${p.wiActivationUnlimited ? ' или больше' : ''}.`,
        `Цель: ${n(p.promptTargetTokens)}. Разница плана: ${stats.plannedDifferenceTokens >= 0 ? '+' : ''}${n(stats.plannedDifferenceTokens)}. После сборки запроса свободное место добирается деталями истории. Ручные квоты, хвост и WI не уменьшаются.`,
        ...(fill ? [`Добор истории: ${fillStatus[fill.status] || fill.status}${fill.error ? ` — ${fill.error}` : ''}.`] : []),
        `Сырой текст сейчас: ≈${n(stats.raw.tokens)}; очередь старого текста: ≈${n(stats.raw.availableTokens)} из ${n(p.compressionTriggerTokens)} до сжатия.`,
        `Защищённые обмены: +≈${n(protectedTokens)} сверх бюджета C.`,
        `${stats.fixed.tokens === null ? 'Оценка с плановым резервом F вместо замера инструкций: ≈' : p.wiActivationUnlimited && wiTokens === undefined ? 'Нижняя оценка: от' : 'Оценка текущих частей: ≈'}${n(stats.accountedTokens)} + защита ≈${n(protectedTokens)} = ${n(stats.fullPromptTokens)}${stats.overflowTokens ? ` · выше C на ${n(stats.overflowTokens)} ещё без защиты` : ''}.`,
        `Инструкции/карточка: ${stats.fixed.tokens === null ? 'резерв F, не замер' : `последний замер ≈${n(stats.fixed.tokens)}`}. WI: ${wiTokens === undefined ? 'ещё не измерена' : 'последняя игровая активация'}. Последний собранный запрос ST: ≈${n(stats.nativeObservedTokens)}; он может отличаться от текущей оценки.`,
        ...(finalAccounted === null ? [] : [`Последний запрос без защищённых обменов: ≈${n(finalAccounted)}; защита +≈${n(finalProtected)} уже включена в полный замер. ${finalAccounted < p.promptTargetTokens
            ? `До C осталось ≈${n(p.promptTargetTokens - finalAccounted)}`
            : `Превышение C ≈${n(finalAccounted - p.promptTargetTokens)}`}.`,
            ...(observed?.finalTopUp?.before === undefined ? [] : [`Финальный добор: ≈${n(observed.finalTopUp.before)} → ≈${n(observed.finalTopUp.after)}, добавлено ≈${n(observed.finalTopUp.addedTokens)} токенов истории.`])])
    ];
    document.getElementById('wm_context_breakdown').replaceChildren(...lines.map(text => {
        const line = document.createElement('div'); line.textContent = text; return line;
    }));
    const counter = tokenCounterStatus(context);
    const counterLabel = counter.mode === 'o200k' ? 'локальный o200k: штатный токенизатор недоступен'
        : counter.mode === 'approx' ? 'грубая оценка по длине: локальные токенизаторы недоступны'
            : counter.mode === 'pending' ? 'проверяется' : counter.nativeVerified ? `штатный ${counter.model}, token IDs проверены` : 'счётчик ST';
    document.getElementById('wm_token_counter_status').textContent = `Счётчик WorldMemory: ${counterLabel}. Это оценка, не usage провайдера. Внутреннее обрезание и WI-сканирование ST используют свой счётчик и могут отличаться.`;
}
function renderHistoryPlacement(s = settings()) {
    const insideHistory = s.injectionPosition === 1 && s.injectionDepth !== 0;
    document.getElementById('wm_injection_position').value = s.injectionPosition === 1 && s.injectionDepth === 0 ? 'chat_end' : s.injectionPosition;
    const depthInput = document.getElementById('wm_injection_depth');
    if (!insideHistory || document.activeElement !== depthInput) depthInput.value = s.injectionDepth;
    document.getElementById('wm_injection_depth_controls').hidden = !insideHistory;
    document.getElementById('wm_injection_depth').disabled = !insideHistory;
    document.getElementById('wm_injection_role').disabled = s.injectionPosition !== 0 && s.injectionPosition !== 1;
    document.getElementById('wm_injection_scan').disabled = s.injectionPosition === -1;
}
function renderSummaryPrompts() {
    if (!archiveRuntime?.inspectPrompts || !document.getElementById('wm_prompt_preview')) return;
    const s = settings(), view = archiveRuntime.inspectPrompts({ wiSystemPrompt: s.auto ? (diffMode() ? DIFF_SYSTEM : SUMMARY_WI_SYSTEM) : null,
        knowledgeActive: Boolean(s.knowledgeBoundaries) });
    for (const [id, key, effective] of [['wm_summary_system_prompt', 'summarizerSystemPrompt', view.baseSystem],
        ['wm_summary_user_prompt', 'summarizerUserPrompt', view.userTemplate]]) {
        const field = document.getElementById(id);
        if (document.activeElement !== field) field.value = effective;
        document.getElementById(`${id}_source`).textContent = describePromptOrigin(key, s, ctx().extensionSettings.summaryception);
    }
    const choice = document.getElementById('wm_prompt_preview_stage').value;
    document.getElementById('wm_prompt_preview').value = view[choice] || view.l0System;
    const select = document.getElementById('wm_prompt_request'), previous = select.value;
    const labels = { l0: 'Этап 1 · L0 + L″', 'refine-l0': 'Этап 1 · Refine L0 + L″', metadata: 'Этап 2 · L′ / поиск / WI',
        'story-spine': 'Подготовка L″', 'legacy-wi': 'Отдельный legacy WI', 'wi-review': 'Проверка последнего DIFF' };
    const states = { sending: 'отправляется', complete: 'ответ получен', error: 'ошибка/остановлен' };
    select.replaceChildren(...view.requests.map(request => new Option(
        `${new Date(request.startedAt).toLocaleTimeString()} · ${labels[request.stage] || request.stage} · ${states[request.status]}`, request.id)));
    if (view.requests.some(request => request.id === previous)) select.value = previous;
    else if (view.requests.length) select.value = view.requests.at(-1).id;
    const request = view.requests.find(request => request.id === select.value);
    select.disabled = !request;
    document.getElementById('wm_prompt_request_info').textContent = request
        ? `${labels[request.stage] || request.stage} · connection: ${request.connection} · model: ${request.model || 'из текущего подключения/профиля ST'} · output: ${request.responseTokens || 'наследуется'}. Это тексты, переданные транспорту WorldMemory; пресет ST и провайдер могут дополнительно преобразовать запрос.`
        : 'Запросов в этой вкладке для открытого чата пока нет. Здесь появятся последние два; после перезагрузки история очищается. Без подключения к API можно смотреть шаблоны выше.';
    document.getElementById('wm_prompt_sent_system').value = request?.systemPrompt || '';
    document.getElementById('wm_prompt_sent_user').value = request?.userPrompt || '';
    document.getElementById('wm_prompt_response').value = request?.responseText || '';
}
async function render() {
    const memory = state(), s = settings(), metadata = ctx().chatMetadata;
    renderWIProblem(memory);
    renderCoverage();
    document.getElementById('wm_diff_status').textContent = diffStatus(memory);
    document.getElementById('wm_review_diff').hidden = !diffMode(memory) && !memory?.wiDiffState?.pending;
    document.getElementById('wm_retry_diff_review').hidden = !memory?.wiDiffReview?.responseText || memory.wiDiffReview.status === 'applied';
    document.getElementById('wm_runtime_version').textContent = `WorldMemory ${VERSION}`;
    const character = ctx().characters[ctx().characterId];
    const embedded = character?.data?.extensions?.worldMemoryBackup;
    const embeddedGame = embedded?.chat;
    document.getElementById('wm_card_resume_panel').hidden = !character || Boolean(ctx().groupId);
    document.getElementById('wm_card_resume_status').textContent = embedded?.format === 'world-memory-gzip-v1'
        ? `В карточке: ${embedded.messages} сообщений · память: ${embedded.packets} L0. В открытом чате: ${ctx().chat.length} сообщений.`
        : embedded?.format === 'world-memory-v1'
        && embeddedGame?.format === 'world-memory-chat-v1' && Array.isArray(embeddedGame.messages)
        ? `В карточке: ${embeddedGame.messages.length} сообщений · память: ${Object.keys(embedded.state?.archive?.records || {}).length} L0. В открытом чате: ${ctx().chat.length} сообщений.`
        : 'В этой карточке нет встроенного чата WorldMemory. Нужен исходный PNG-файл с полной игрой.';
    scheduleContextStatistics();
    const integration = globalThis.RussianWIForms?.getStatus?.();
    document.getElementById('wm_integration').textContent = `Archive: ${bridge()?.version || 'loading'} · Russian WI: ${integration ? integration.enabled ? integration.ready ? 'ready' : 'loading dictionary' : 'disabled' : 'not loaded (optional)'}`;
    document.getElementById('wm_book').textContent = chatWorldInfo(ctx())
        ? `Книга записи: ${chatWorldInfo(ctx())}. Ручные записи сохраняются.`
        : 'Выберите WI этого чата: запись в случайный или активный ворлдбук не выполняется.';
    const cardWI = document.getElementById('wm_card_wi'), linkedWI = chatWorldInfo(ctx());
    cardWI.replaceChildren(new Option('Не выбран — выберите WI для этого чата', ''),
        ...(nativeWI.world_names || []).map(name => new Option(name, name)));
    cardWI.value = linkedWI;
    document.getElementById('wm_card_wi_status').textContent = linkedWI
        ? (nativeWI.world_names || []).includes(linkedWI)
            ? `Результат будет записан в ${linkedWI}. Ручные записи не перезаписываются; карточка и глобальные WI не меняются.`
            : `Выбранная книга ${linkedWI} отсутствует. Выберите другую; автоматической подмены нет.`
        : 'WI этого чата не выбран. История сохраняется; подготовка WI ждёт выбора. Книга из карточки или активного списка не подставляется.';
    const wiResults = Object.values(memory?.wiPackets || {}), wiPending = wiResults.filter(item => item.status === 'error' || item.status === 'stale');
    document.getElementById('wm_saved_wi_status').textContent = `${wiCoverage(memory)} ${wiPending.length
        ? `${wiPending.length} результат(ов) требуют внимания: ${wiPending[0].message}`
        : 'Новые сообщения попадают сюда после сохранения L0; несжатый хвост ещё не обработан.'}`;
    $('#wm_main_names').val(memory?.mainNames.join('\n') || '');
    const characters = document.getElementById('wm_characters'), records = document.getElementById('wm_records');
    characters.replaceChildren(); records.replaceChildren();
    const book = memory?.book ? await getBook() : null;
    if (ctx().chatMetadata !== metadata || state()?.owner !== memory?.owner) return;
    for (const entry of ownedEntries(book, memory?.owner)) {
        const meta = entryMeta(entry), manual = detectManual(entry);
        const panel = document.createElement('div'); panel.className = 'wm-record';
        const header = document.createElement('header'), title = document.createElement('strong');
        title.textContent = `${entry.comment} · #${entry.uid}${meta.main ? ' · main' : ''}${manual ? ' · manual' : ''}`;
        header.append(title, button(manual ? 'Allow automatic updates' : 'Keep manual', async () => {
            if (busy) return;
            if (ctx().chatMetadata !== metadata || state()?.owner !== memory.owner) return;
            const data = await getBook(); const target = data.entries[entry.uid]; entryMeta(target).manual = !manual;
            if (ctx().chatMetadata !== metadata || state()?.owner !== memory.owner) return;
            markGenerated(target); await saveBook(data, ctx().chatMetadata); await render();
        }));
        const text = document.createElement('pre'); text.textContent = entry.content || 'Waiting for played information.';
        const sources = document.createElement('small'); sources.className = 'wm-muted';
        sources.textContent = `Keys: ${entry.key.join(', ')} · ${Object.keys(meta.contributions || {}).length} source packets`;
        panel.append(header, sources, text); (meta.type === 'character' ? characters : records).append(panel);
    }
    for (const control of document.querySelectorAll('.world-memory-settings [data-setting]')) {
        if (document.activeElement === control) continue;
        if (control.type === 'checkbox') control.checked = control.dataset.setting === 'wiDiffs' ? diffMode(memory) : Boolean(s[control.dataset.setting]);
        else control.value = s[control.dataset.setting] ?? '';
    }
    renderHistoryPlacement(s);
    renderSummaryPrompts();
    for (const group of document.querySelectorAll('[data-connection]')) group.hidden = group.dataset.connection !== s.connectionSource;
    document.getElementById('wm_embedding_mode').value = s.historyEmbeddingMode === 'local' ? 'local' : 'api';
    document.getElementById('wm_embedding_mode').disabled = !(s.historySemantic || s.wiSemantic);
    document.getElementById('wm_spine_rerank').disabled = !s.historySemantic;
    document.getElementById('wm_awareness_graph').disabled = !s.knowledgeBoundaries;
    document.getElementById('wm_summarizer_wi_percent').disabled = !s.summarizerWorldInfo;
    const api = s.historyEmbeddingAPI || {}, local = s.historyEmbeddingLocal || {};
    for (const [id, key, fallback] of [['wm_embedding_url', 'url', ''], ['wm_embedding_key', 'key', ''],
        ['wm_embedding_model', 'model', 'gemini-embedding-2-preview'], ['wm_embedding_dimensions', 'dimensions', 768],
        ['wm_embedding_transport', 'transport', 'google-native']]) {
        const input = document.getElementById(id);
        if (document.activeElement !== input) input.value = api[key] ?? fallback;
    }
    const localURL = document.getElementById('wm_embedding_local_url');
    if (document.activeElement !== localURL) localURL.value = local.apiUrl || 'http://127.0.0.1:8081';
    document.getElementById('wm_embedding_api_fields').hidden = s.historyEmbeddingMode === 'local';
    document.getElementById('wm_embedding_local_fields').hidden = s.historyEmbeddingMode !== 'local';
    renderBusy(); renderWIStatus();
}
async function applySettings({ nativeWIBudget = false } = {}) {
    const s = settings(), context = ctx(), memory = state(), metadata = context.chatMetadata;
    if (nativeWIBudget) { applyNativeWIBudget(); wiSize = null; wiMeasurementSerial++; }
    const owner = memory?.owner, name = memory?.book;
    const check = () => {
        if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || ctx().chatId !== context.chatId
            || state() !== memory || memory?.owner !== owner || memory?.book !== name) {
            throw new Error('Chat or WI book changed. Settings were not applied to another chat.');
        }
    };
    renderHistoryPlacement(s);
    document.getElementById('wm_embedding_mode').disabled = !(s.historySemantic || s.wiSemantic);
    document.getElementById('wm_summarizer_wi_percent').disabled = !s.summarizerWorldInfo;
    if (!s.enabled) {
        archiveRuntime.stop(); history.stop();
        if (context.chatId && !busy) {
            await restoreAutomaticGhosts(context.chat); check();
            await saveArchive({ context }); check();
        }
    }
    history.changed();
    semanticWI?.invalidate();
    context.saveSettingsDebounced();
    if (s.enabled && await claimArchiveRuntime()) return;
    check();
    if (!name || busy) { await render(); return; }
    busy = true; renderBusy();
    try {
        const base = await getBook(); check();
        const book = structuredClone(base);
        for (const entry of ownedEntries(book, owner)) {
            if (detectManual(entry)) continue;
            Object.assign(entry, { position: s.position, depth: s.depth, constant: entryMeta(entry).main && s.alwaysMain }); markGenerated(entry);
        }
        await saveBook(book, metadata, base); check();
    } finally { busy = false; renderBusy(); }
    await render();
}
function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function downloadWIDiagnostics() {
    const context = ctx(), memory = state();
    if (!context.chatId || !memory) { status('Откройте чат для диагностики WI.'); return; }
    const snapshot = archiveRuntime.snapshot({ effective: false });
    const packets = snapshot.packets.map(packet => {
        const record = memory.archive.records[packet.id], outcome = memory.wiPackets?.[packet.id];
        return { packetId: packet.id, order: packet.order, sourceStatus: packet.sourceStatus, stale: packet.stale,
            annotationStatus: record.annotationStatus || null, annotationError: record.annotationError || null,
            savedWI: hasSavedWI(record), currentWI: hasSavedWI(packet),
            wiDiff: record.memoryMetadata?.wiDiff || null,
            updates: record.memoryMetadata?.wi?.updates?.map(update => ({ uid: update.uid, name: update.name, type: update.type })) || [],
            wiStatus: record.memoryMetadata?.wiStatus || null, wiContext: record.memoryMetadata?.wiContext || null,
            writeOutcome: outcome ? structuredClone(outcome) : null };
    });
    const failures = Object.values(memory.archive?.records || {}).filter(record => !record.deleted
        && (record.annotationResponse || record.annotationError)).map(record => ({ packetId: record.id,
        annotationStatus: record.annotationStatus, error: record.annotationError || record.annotationResponse?.error, response: record.annotationResponse || null }));
    const requests = archiveRuntime.inspectPrompts().requests.filter(request => ['metadata', 'legacy-wi', 'wi-review'].includes(request.stage));
    const byId = new Map(Object.values(memory.archive?.responses || {}).map(response => [response.id, response]));
    for (const request of requests) if (!byId.has(request.id)) byId.set(request.id, request);
    for (const failure of failures) if (typeof failure.response?.text === 'string') {
        const id = failure.response.requestId || `packet:${failure.packetId}`;
        if (!byId.has(id)) byId.set(id, { id, packetId: failure.packetId, stage: 'metadata',
            responseText: failure.response.text, error: failure.error });
    }
    const responses = [...byId.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const responseCount = responses.filter(response => typeof response.responseText === 'string' && response.responseText.length > 0).length;
    const rawResponseBodyCount = responses.filter(response => typeof response.rawResponseBody === 'string' && response.rawResponseBody.length > 0).length;
    download(`WorldMemory-WI-diagnostics-${Date.now()}.json`, { format: 'world-memory-wi-diagnostics-v1',
        version: VERSION, createdAt: new Date().toISOString(), responseCount, rawResponseBodyCount, responses,
        selectedBook: chatWorldInfo(context), destinationBook: memory.book, coverage: wiCoverage(memory),
        runtime: { enabled: Boolean(settings().enabled), autoApply: Boolean(settings().auto),
            archiveBusy: archiveRuntime.isBusy(), wiBusy: busy },
        lastWIWrite: memory.lastWIWrite || null, wiDiffState: memory.wiDiffState || null, wiDiffReview: memory.wiDiffReview || null, packets, failures, requests });
    status(responseCount
        ? `В диагностике ${responseCount} полных/частичных текстов ответа: responses → responseText. Они сохраняются после перезагрузки. Файл содержит текст игры; поля API-подключения не включены.`
        : rawResponseBodyCount ? `Текст модели не извлечён, но в файле есть ${rawResponseBodyCount} сырых HTTP/stream ответов: responses → rawResponseBody.`
            : 'В файле 0 текстов ответа модели — только сведения об ошибках/запросах. Новых полученных ответов в этом чате ещё нет; утраченные старой версией ответы восстановить нельзя.');
}
let supportExporting = false;
let supportImporting = false;
async function importEverything(file) {
    if (supportImporting || supportExporting || busy || archiveRuntime.isBusy()) throw new Error('Дождитесь текущей операции с памятью.');
    supportImporting = true; busy = true; restoringCardGame = true;
    controller = new AbortController();
    const signal = controller.signal, initial = ctx();
    clearTimeout(timer); clearTimeout(cardRestoreTimer); archiveRuntime.stop(); history.stop(); semanticWI.invalidate(); renderBusy();
    const check = () => {
        signal.throwIfAborted();
        if (ctx().chatMetadata !== initial.chatMetadata || ctx().chatId !== initial.chatId)
            throw new Error('Чат изменился во время импорта. Уже созданные копии сохранены отдельно.');
    };
    let prepared, importedAvatar;
    try {
        const native = await import('/script.js');
        status('Импорт всего: чтение файла и подготовка отдельной копии…');
        const bundle = JSON.parse(await file.text()); check();
        await native.getCharacters(); await nativeWI.updateWorldInfoList(); check();
        prepared = prepareSupportImport(bundle, { characterNames: ctx().characters.map(card => card.name),
            avatarNames: ctx().characters.map(card => card.avatar), bookNames: nativeWI.world_names });
        if (prepared.backup) {
            const packed = await packCardBackup(prepared.backup); check();
            prepared.card.data.extensions.worldMemoryBackup = packed;
            prepared.card.extensions.worldMemoryBackup = packed;
        }
        let upload = new Blob([JSON.stringify(prepared.card)], { type: 'application/json' }), format = 'json';
        if (bundle.cover?.dataUrl) {
            if (!bundle.cover.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Обложка в экспорте должна быть PNG.');
            const cover = await fetch(bundle.cover.dataUrl); check();
            upload = portablePng(await cover.arrayBuffer(), prepared.card); format = 'png'; check();
        }
        for (const [name, book] of Object.entries(prepared.books)) {
            check();
            if (!await nativeWI.createNewWorldInfo(name, { interactive: false })) throw new Error(`Не удалось создать отдельную WI-книгу: ${name}`);
            await writeNativeBook(name, book, check);
        }
        status(`Импорт всего: создание ${prepared.name}…`);
        const form = new FormData();
        form.append('avatar', new File([upload], `WorldMemory.${format}`, { type: upload.type })); form.append('file_type', format);
        const response = await fetch('/api/characters/import', { method: 'POST', headers: initial.getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`Не удалось импортировать карточку (HTTP ${response.status}).`);
        const result = await response.json(); check();
        if (!result.file_name || result.error) throw new Error('ST не создал карточку.');
        importedAvatar = result.file_name.endsWith('.png') ? result.file_name : `${result.file_name}.png`;
        // portablePng removes installation bindings. Restore only this new card's
        // mapped extensions, never a previously selected character's form.
        let stored = await readCharacterCard(importedAvatar); check();
        // Native import sanitizes both the filename and display name. Preserve
        // the author's display name independently of the new file on disk.
        if (stored.data.name !== prepared.name) {
            const renamed = await fetch('/api/characters/edit-attribute', { method: 'POST', headers: initial.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: importedAvatar, ch_name: stored.data.name, field: 'name', value: prepared.name }) });
            if (!renamed.ok) throw new Error(`Не удалось сохранить имя копии (HTTP ${renamed.status}).`);
            stored = await readCharacterCard(importedAvatar); check();
        }
        await writeCardExtensions(importedAvatar, stored, prepared.card.data.extensions); check();
        const json = async (url, data) => {
            const response = await fetch(url, { method: 'POST', headers: initial.getRequestHeaders(), body: JSON.stringify(data) });
            if (!response.ok) throw new Error(`Импорт чата: HTTP ${response.status}.`);
            return response.json();
        };
        await json('/api/chats/get', { avatar_url: importedAvatar }); check();
        prepared.metadata.worldMemoryCardImport = { avatar: importedAvatar, importedAt: Date.now(), format: bundle.format };
        const header = { user_name: bundle.chat.playerName || initial.name1, character_name: prepared.name,
            create_date: new Date().toISOString(), chat_metadata: prepared.metadata };
        const saved = await json('/api/chats/save', { avatar_url: importedAvatar, file_name: prepared.chatId,
            chat: [header, ...prepared.messages] }); check();
        if (!saved.ok) throw new Error('ST не подтвердил сохранение полного чата.');
        const received = await json('/api/chats/get', { avatar_url: importedAvatar, file_name: prepared.chatId }); check();
        if (!Array.isArray(received) || JSON.stringify(received) !== JSON.stringify([header, ...prepared.messages]))
            throw new Error('Сохранённый чат не совпал с импортом. Копии оставлены для восстановления.');
        if (prepared.extraBooks.length) {
            nativeWI.world_info.charLore ??= [];
            nativeWI.world_info.charLore.push({ name: importedAvatar.replace(/\.png$/i, ''), extraBooks: prepared.extraBooks });
            initial.saveSettingsDebounced();
        }
        // Selection emits CHAT_CHANGED, which cancels the old chat's controller.
        // All writes are complete before opening the independently saved game.
        controller = null;
        await native.getCharacters();
        const id = ctx().characters.findIndex(card => card.avatar === importedAvatar);
        if (id < 0) throw new Error('Копия сохранена, но ST не обновил список карточек. Перезагрузите страницу.');
        await ctx().selectCharacterById(id);
        await ctx().openCharacterChat(prepared.chatId);
        if (ctx().chatId !== prepared.chatId || ctx().characters[ctx().characterId]?.avatar !== importedAvatar)
            throw new Error('Копия сохранена; откройте её чат в списке карточек.');
        history.changed(); semanticWI.invalidate();
        status(`Импортировано: ${prepared.name}; сообщений ${prepared.messages.length}, WI-книг ${Object.keys(prepared.books).length}. Чат и вся сохранённая память готовы к продолжению.`);
    } catch (error) {
        if (importedAvatar) error.message += ` Отдельная карточка: ${prepared.name}.`;
        throw error;
    } finally {
        clearTimeout(timer); controller = null; busy = false; restoringCardGame = false; supportImporting = false;
        renderBusy(); await render(); await renderArchive();
    }
}
async function exportEverything() {
    if (supportExporting) return;
    const context = ctx(), metadata = context.chatMetadata;
    if (!context.chatId) { status('Откройте чат для экспорта всех данных.'); return; }
    supportExporting = true;
    $('#wm_export_all').prop('disabled', true);
    try {
        const character = context.characters?.[context.characterId], avatar = character?.avatar;
        const nativeSettings = {};
        for (const key of ['chat_completion_source', 'openai_model', 'claude_model', 'google_model', 'custom_model',
            'custom_url', 'reverse_proxy', 'openai_max_context', 'openai_max_tokens', 'stream_openai',
            'temperature', 'top_p', 'names_behavior', 'custom_prompt_post_processing'])
            if (context.chatCompletionSettings?.[key] !== undefined) nativeSettings[key] = context.chatCompletionSettings[key];
        const worldInfo = { bindings: { global: nativeWI.selected_world_info || [],
            character: character?.data?.extensions?.world || null,
            chat: metadata.world_info || null, persona: context.powerUserSettings?.persona_description_lorebook || null,
            extra: (nativeWI.world_info?.charLore || []).filter(row => row.name === avatar || row.name === avatar?.replace(/\.png$/i, ''))
                .flatMap(row => row.extraBooks || []) } };
        // Export the books this imported chat actually uses, including copies of
        // globally selected originals that are suppressed in its native scan.
        const importedBooks = metadata.worldMemoryImport?.books || {};
        for (const [key, value] of Object.entries(worldInfo.bindings)) worldInfo.bindings[key] = Array.isArray(value)
            ? value.map(name => importedBooks[name] || name) : importedBooks[value] || value;
        for (const key of ['world_info_depth', 'world_info_budget', 'world_info_budget_cap', 'world_info_recursive',
            'world_info_match_whole_words', 'world_info_case_sensitive', 'world_info_character_strategy', 'world_info_max_recursion_steps'])
            worldInfo[key] = nativeWI[key];
        const bundle = await collectSupportBundle({ context, version: VERSION,
            settings: { worldMemory: context.extensionSettings.worldMemory, russianWIForms: context.extensionSettings.russianWIForms,
                vectorStorage: context.extensionSettings.vectors,
                summarizerProfile: context.extensionSettings.connectionManager?.profiles?.find(profile => profile.id === context.extensionSettings.worldMemory?.connectionProfileId) || null,
                native: nativeSettings, disabledExtensions: context.extensionSettings.disabledExtensions || [] },
            worldInfo, environment: { userAgent: navigator.userAgent, language: navigator.language,
                viewport: { width: innerWidth, height: innerHeight },
                tokenizer: context.powerUserSettings?.tokenizer, mainApi: context.mainApi, maxContext: context.maxContext,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                loadedAddonModules: [...new Set(performance.getEntriesByType('resource').map(entry => {
                    try { return new URL(entry.name).pathname; } catch { return ''; }
                }).filter(path => path.includes('/scripts/extensions/')))] },
            inspections: { prompts: () => archiveRuntime.inspectPrompts(), history: () => history.inspect(),
                semanticWI: () => semanticWI.inspect(), knowledge: () => knowledgeRuntime.inspect(),
                contextBudget: () => lastContextStatistics, nativePromptSize: () => nativePromptSize,
                wiSize: () => wiSize, lastNativeWIScan: () => lastNativeWIScan,
                ui: () => Object.fromEntries(['wm_status', 'wm_wi_problem', 'wm_saved_wi_status', 'wm_prompt_size', 'wm_coverage_summary']
                    .map(id => [id, document.getElementById(id)?.textContent || ''])) },
            readBook: async name => {
                // ST's /get returns an empty dummy book for an unknown name.
                // Preserve that distinction instead of reporting it as saved WI.
                if (Array.isArray(nativeWI.world_names) && !nativeWI.world_names.includes(name))
                    throw new Error(`WI absent from ST book catalogue: ${name}`);
                const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name }) });
                if (!response.ok) throw new Error(`HTTP ${response.status}: ${name}`);
                const book = await response.json();
                if (!book?.entries) throw new Error(`WI not found: ${name}`);
                return book;
            },
            readCover: async sourceAvatar => {
                const response = await fetch(`/characters/${encodeURIComponent(sourceAvatar)}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`Cover HTTP ${response.status}`);
                // The card JSON is captured separately. Drop its bulky PNG text
                // chunks without decoding them; raster/cover chunks stay exact.
                const cover = portablePng(await response.arrayBuffer(), { spec: 'chara_card_v2', spec_version: '2.0', data: { name: character.data?.name || character.name } });
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(cover);
                });
                return { avatar: sourceAvatar, dataUrl, cardTextCapturedSeparately: true };
            } });
        if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat)
            throw new Error('Чат сменился во время экспорта. Нажмите «Экспорт всего» в нужном чате.');
        download(`WorldMemory-all-${Date.now()}.json`, bundle);
        status(`Экспортировано одним файлом: ${bundle.counts.messages} сообщений, ${bundle.counts.l0} L0, ${bundle.counts.books} книг WI.${bundle.errors.length ? ` Не удалось прочитать разделов: ${bundle.errors.length}; причины указаны в файле, остальные данные сохранены.` : ''} Файл содержит игру и ответы модели; ключи подключения не экспортированы.`);
    } finally { supportExporting = false; $('#wm_export_all').prop('disabled', false); }
}
async function exportBackup() {
    const context = ctx(), metadata = context.chatMetadata, memory = state();
    if (!memory) throw new Error('Open a chat to export its saved memory.');
    const book = await getBook(Boolean(memory.cloneFrom));
    if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || state() !== memory)
        throw new Error('Chat changed. Export the memory of the selected chat again.');
    const saved = structuredClone(memory);
    for (const packet of archiveRuntime.snapshot({ effective: false }).packets) for (const source of packet.sources)
        saved.archive.sources[source.id] = structuredClone(source);
    return { format: 'world-memory-v1', version: VERSION, state: saved, book };
}
async function readCharacterCard(avatar) {
    // Export strips private native fields such as favourites; read the stored card instead.
    const response = await fetch('/api/characters/get', { method: 'POST', headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }) });
    if (!response.ok) throw new Error(`Could not read the character card (HTTP ${response.status}).`);
    const result = await response.json();
    const raw = typeof result.json_data === 'string' ? JSON.parse(result.json_data) : null;
    const card = raw?.data ? raw : result;
    if (!card.data?.name) throw new Error('The selected character has no valid V2 card data.');
    // Raw card JSON can contain an avatar/chat from another installation.
    card.avatar = avatar; card.chat = result.chat;
    return card;
}
async function writeCardExtensions(avatar, card, extensions) {
    const response = await fetch('/api/characters/edit-attribute', { method: 'POST', headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, ch_name: card.data.name, field: 'extensions', value: extensions }) });
    if (!response.ok) throw new Error(`Could not write card memory (HTTP ${response.status}).`);
    const written = await readCharacterCard(avatar);
    const character = ctx().characters.find(item => item.avatar === avatar);
    if (character) {
        character.data ??= {}; character.data.extensions = structuredClone(written.data.extensions);
        character.json_data = JSON.stringify(written);
        if (ctx().characters[ctx().characterId]?.avatar === avatar) {
            $('#character_json_data').val(character.json_data);
            $('#character_world').val(written.data.extensions?.world || '');
        }
    }
    return written;
}
async function selectChatWI() {
    if (busy || archiveRuntime.isBusy()) throw new Error('Wait for the current request to finish before changing the chat WI.');
    const memory = state();
    if (!memory) throw new Error('Open a chat first.');
    const name = document.getElementById('wm_card_wi').value;
    if (name && !nativeWI.world_names.includes(name)) throw new Error('Choose an existing World Info book. Create or import one in ST World Info first.');
    clearTimeout(timer); archiveRuntime.stop();
    busy = true; controller = new AbortController(); renderBusy();
    try {
        memory.wiSourceBook = name;
        await saveState();
        if (name) await getBook(true);
        status(name ? `Книга записи WI этого чата: ${name}. Существующие записи сохранены.` : 'WI этого чата отключён. История сохранена; чужая книга не подставляется.');
    } finally {
        controller = null; busy = false; renderBusy(); await render();
    }
}
function selectedCardAvatar() {
    const context = ctx(), avatar = context.characters[context.characterId]?.avatar;
    if (context.groupId || !avatar) throw new Error('Select an individual character chat for card memory.');
    return avatar;
}
async function saveMemoryToCard() {
    if (busy || archiveRuntime.isBusy()) throw new Error('Wait for the current memory operation before exporting the game.');
    if (!state()) throw new Error('Open the character chat to export its game.');
    const context = ctx(), metadata = context.chatMetadata, avatar = selectedCardAvatar();
    busy = true; controller = new AbortController(); clearTimeout(timer); renderBusy();
    const check = () => {
        controller.signal.throwIfAborted();
        if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || selectedCardAvatar() !== avatar)
            throw new Error('Chat or character changed. Card memory was not updated.');
    };
    try {
        const savedBackup = await prepareCardBackup(context, check), card = await readCharacterCard(avatar); check();
        // Replace this snapshot exactly; a deep merge would retain removed archive records.
        // Read fresh extensions first so native WI bindings and unrelated addons survive.
        const extensions = { ...card.data.extensions, worldMemoryBackup: savedBackup };
        const written = await writeCardExtensions(avatar, card, extensions); check();
        if (JSON.stringify(written.data.extensions?.worldMemoryBackup) !== JSON.stringify(savedBackup))
            throw new Error('The card write could not be verified. Keep the separate backup.');
        status('Complete game saved in the character card: chat, memory, outline and WI. Export it as PNG in ST.');
    } finally { controller = null; busy = false; renderBusy(); }
}
async function prepareCardBackup(context, check) {
    const backup = await exportBackup(); check();
    const chatMetadata = structuredClone(context.chatMetadata); delete chatMetadata[OWNER];
    const character = context.characters?.[context.characterId];
    backup.chat = { format: 'world-memory-chat-v1', messages: structuredClone(context.chat), metadata: chatMetadata,
        character: { name: character?.name, avatar: character?.avatar } };
    if (chatMetadata.world_info) {
        const chatLore = await nativeWI.loadWorldInfo(chatMetadata.world_info); check();
        if (chatLore?.entries) backup.chat.worldInfo = { name: chatMetadata.world_info, data: structuredClone(chatLore) };
    }
    const packed = await packCardBackup(backup); check();
    return packed;
}
async function loadMemoryFromCard() {
    if (busy || archiveRuntime.isBusy() || !state()) return;
    const context = ctx(), metadata = context.chatMetadata, avatar = selectedCardAvatar();
    const card = await readCharacterCard(avatar);
    if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || selectedCardAvatar() !== avatar)
        throw new Error('Chat or character changed. Card memory was not imported.');
    const backup = await unpackCardBackup(card.data.extensions?.worldMemoryBackup);
    if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || selectedCardAvatar() !== avatar)
        throw new Error('Chat or character changed. Card memory was not imported.');
    if (!backup) throw new Error('This card has no WorldMemory snapshot. Use Save memory to card first.');
    await importBackup(backup);
}
async function importBackup(input) {
        let reserved = false, context, memory, metadata, next, published = false, committed = false;
        let previousWorldInfo, previousImport, movedBindings = false;
        try {
            if (busy || archiveRuntime.isBusy() || !state()) return;
            context = ctx(); metadata = context.chatMetadata; memory = state();
            const owner = memory.owner, originalBook = memory.book;
            busy = true; reserved = true; controller = new AbortController();
            const signal = controller.signal;
            clearTimeout(timer); archiveRuntime.stop(); history.stop(); semanticWI.invalidate(); renderBusy();
            const check = (expected = memory) => {
                signal.throwIfAborted();
                if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || ctx().chatId !== context.chatId
                    || metadata[OWNER] !== expected || expected.owner !== owner
                    || (expected === memory && memory.book !== originalBook) || archiveRuntime.isBusy()) {
                    throw new Error('The receiving chat or memory changed. Backup import was cancelled.');
                }
            };
            const data = typeof input === 'function' ? await input() : input;
            check();
            if (data?.format !== 'world-memory-v1' || (!data.book?.entries && !data.state?.archive)) throw new Error('Import a World Memory backup; native lorebooks can be imported in ST World Info.');
            const object = value => value && typeof value === 'object' && !Array.isArray(value);
            if (data.state && !object(data.state)) throw new Error('Backup memory state must be an object.');
            next = structuredClone(memory);
            next.mainNames = structuredClone(data.state?.mainNames || []);
            if (!Array.isArray(next.mainNames) || next.mainNames.some(name => typeof name !== 'string')) throw new Error('Backup character names must be a list of strings.');
            const foreign = data.state?.chatId !== context.chatId;
            next.packets = structuredClone(foreign ? {} : data.state?.packets || {});
            next.wiPackets = {};
            next.history = structuredClone(foreign ? {} : data.state?.history || {});
            if (!object(next.packets) || !object(next.history)) throw new Error('Backup packet and history state must be objects.');
            if (data.state?.archive) {
                next.archive = createArchive(data.state.archive);
                if (![next.archive.records, next.archive.sources, next.archive.legacy].every(object)) throw new Error('Backup archive records, sources and legacy state must be objects.');
                for (const record of Object.values(next.archive.records)) {
                    if (!object(record) || typeof record.id !== 'string' || typeof record.text !== 'string'
                        || !Array.isArray(record.sourceMessageIds) || record.sourceMessageIds.some(id => typeof id !== 'string')) {
                        throw new Error('Backup archive has an invalid packet or source-link list.');
                    }
                }
                if (foreign) {
                    const present = new Set(context.chat.map(message => message.sc_message_id || message.extra?.sc_message_id).filter(Boolean));
                    for (const record of Object.values(next.archive.records)) record.unavailableSourceIds = record.sourceMessageIds.filter(id => !present.has(id));
                }
            }
            let book = data.book?.entries ? structuredClone(data.book) : null;
            if (book && (!object(book.entries) || Object.values(book.entries).some(entry => !object(entry)
                || !Number.isInteger(entry.uid) || !Array.isArray(entry.key) || entry.key.some(key => typeof key !== 'string')
                || typeof entry.comment !== 'string' || typeof entry.content !== 'string'
                || (entryMeta(entry) && !object(entryMeta(entry)))))) throw new Error('Backup contains an invalid native WI entry.');
            const character = context.characters?.[context.characterId];
            const complete = book ? rebindCompleteBackup(data, { owner, chatId: context.chatId,
                bookName: `WorldMemory_${owner}_import_${crypto.randomUUID()}`, messages: context.chat,
                avatar: character?.avatar, characterNames: [character?.name, character?.data?.name], authorBook: chatWorldInfo(context) }) : null;
            if (complete) { next = complete.state; book = complete.book; }
            for (const entry of Object.values(book?.entries || {})) {
                const meta = entryMeta(entry); if (!meta) continue;
                if (!object(meta.contributions)) throw new Error('Backup managed WI contributions must be an object.');
                if (complete) continue;
                meta.owner = owner;
                if (foreign) { meta.manual = true; meta.contributions = {}; }
            }
            if (book) {
                // Publish the imported book with the metadata pointer. Never overwrite
                // the receiving book: a failed save still leaves the old pair recoverable.
                if (!complete) next.book = `WorldMemory_${owner}_import_${crypto.randomUUID()}`;
                delete next.cloneFrom;
                delete next.cloneOwner;
                if (!complete && data.state?.book && data.state?.owner) rebindKnowledgeIdentities(next.archive,
                    { book: data.book, world: data.state.book, owner: data.state.owner },
                    { book, world: next.book, owner });
                if (!complete && !foreign && data.state?.archive) for (const record of Object.values(next.archive.records)) {
                    const stamp = record.memoryMetadata?.wiContext;
                    if (stamp?.owner === data.state.owner && stamp.book === data.state.book) {
                        stamp.owner = owner; stamp.book = next.book;
                    }
                }
                check();
                if (!await nativeWI.createNewWorldInfo(next.book, { interactive: false })) throw new Error('ST could not create the imported WI book. Previous memory was kept.');
                check();
                await nativeWI.saveWorldInfo(next.book, book, true); check();
            }
            check();
            if (complete && data.state.wiSourceBook === data.state.book) {
                previousWorldInfo = metadata.world_info; previousImport = metadata.worldMemoryImport;
                const provenance = structuredClone(previousImport || {}), bindings = complete.bindings;
                provenance.books = Object.fromEntries(Object.entries(provenance.books || {}).map(([old, name]) => [old, bindings[name] || name]));
                Object.assign(provenance.books, bindings);
                if (previousWorldInfo && previousWorldInfo !== next.book) provenance.books[previousWorldInfo] = next.book;
                metadata.world_info = next.book; metadata.worldMemoryImport = provenance; movedBindings = true;
            }
            metadata[OWNER] = next; published = true;
            check(next);
            await context.saveMetadata();
            committed = true;
            if (complete && restoringCardGame && metadata.world_info === next.book && character?.avatar) {
                const card = await readCharacterCard(character.avatar); check(next);
                await writeCardExtensions(character.avatar, card, { ...card.data.extensions, world: next.book }); check(next);
            }
            history.changed();
            if (ctx().chatMetadata === metadata) {
                await render(); await renderArchive();
                status('Backup imported. Review the saved archive and source links before summarizing.');
            }
            return true;
        } catch (error) {
            if (published && !committed && metadata[OWNER] === next) {
                metadata[OWNER] = memory;
                if (movedBindings) {
                    if (previousWorldInfo === undefined) delete metadata.world_info; else metadata.world_info = previousWorldInfo;
                    if (previousImport === undefined) delete metadata.worldMemoryImport; else metadata.worldMemoryImport = previousImport;
                }
                // A native save can fail after reaching the server. Keep the prepared
                // book for recovery; never delete a possible persisted metadata target.
                if (ctx().chatMetadata === metadata && ctx().chat === context.chat) {
                    try { await context.saveMetadata(); }
                    catch (restoreError) { console.error('[WorldMemory] Could not persist restored memory.', restoreError); }
                }
            }
            history?.changed(); semanticWI?.invalidate();
            status(error.message); toastr.warning(error.message, 'World Memory');
            return false;
        } finally {
            if (reserved) { controller = null; busy = false; renderBusy(); }
        }
}

async function restoreEmbeddedCardGame() {
    return restoreCardGame(false);
}
function cardRestoreError(error) {
    console.error('[WorldMemory] Embedded game restore failed.', error);
    status(error.message);
    const note = document.getElementById('wm_card_resume_status');
    if (note) note.textContent = error.message;
    toastr.warning(error.message, 'World Memory · card restore');
}
async function restoreCardGame(explicit = false) {
    if (restoringCardGame || !settings().enabled || ctx().groupId || !state()) {
        if (explicit) throw new Error('Enable WorldMemory and open an individual character chat first.');
        return false;
    }
    const context = ctx(), character = context.characters[context.characterId];
    let backup = character?.data?.extensions?.worldMemoryBackup;
    if (explicit) {
        const card = await readCharacterCard(character.avatar);
        if (ctx().chatMetadata !== context.chatMetadata || ctx().characters[ctx().characterId]?.avatar !== character.avatar)
            throw new Error('Chat changed. No embedded game was imported.');
        backup = card.data?.extensions?.worldMemoryBackup;
    }
    // ST expands greeting macros (including random/empty ones). Compare the
    // literal portions without evaluating those macros a second time.
    const greeting = character.first_mes || '';
    const renderedGreeting = greeting.replace(/\{\{\s*(user|char)\s*\}\}/gi, (tag, name) =>
        (name.toLowerCase() === 'user' ? context.name1 : context.chat[0]?.name || character.name) ?? tag);
    const greetingParts = greeting.split(/\{\{[^{}]*\}\}/g);
    const expandedGreeting = greetingParts.length > 1 && greetingParts.join('').trim().length >= 32
        && new RegExp('^' + greetingParts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[\\s\\S]*?') + '$').test(context.chat[0]?.mes || '');
    const fresh = context.chat.length === 0 || (context.chat.length === 1 && !context.chat[0].is_user
        && (context.chat[0].mes === greeting || context.chat[0].mes === renderedGreeting || expandedGreeting));
    if (!explicit && (!fresh || Object.keys(getArchive().records).length || context.chatMetadata.worldMemoryCardImport)) return false;
    backup = await unpackCardBackup(backup);
    if (ctx().chatMetadata !== context.chatMetadata || ctx().characters[ctx().characterId]?.avatar !== character.avatar)
        throw new Error('Chat changed. No embedded game was imported.');
    const game = backup?.chat;
    if (backup?.format !== 'world-memory-v1' || game?.format !== 'world-memory-chat-v1'
        || !Array.isArray(game.messages) || !game.messages.length) {
        if (explicit) throw new Error('This card has no embedded game chat. Import the original PNG as a file, not a compressed photo.');
        return false;
    }
    if (busy || archiveRuntime.isBusy() || (!explicit && document.querySelector('dialog[open]'))) {
        if (explicit) throw new Error('Wait for the current memory operation to finish, then restore the card game.');
        clearTimeout(cardRestoreTimer);
        const metadata = context.chatMetadata, avatar = character.avatar;
        cardRestoreTimer = setTimeout(() => {
            if (ctx().chatMetadata === metadata && ctx().characters[ctx().characterId]?.avatar === avatar)
                void restoreEmbeddedCardGame().catch(cardRestoreError);
        }, 300);
        return false;
    }
    if (game.messages.some(message => !message || typeof message !== 'object' || typeof message.mes !== 'string'))
        throw new Error('The card contains an invalid chat. The existing chat was kept.');
    restoringCardGame = true; busy = true; renderBusy(); clearTimeout(timer);
    const avatar = character.avatar, initialMetadata = context.chatMetadata;
    let savedCurrentChat = null;
    const check = () => {
        if (ctx().characters[ctx().characterId]?.avatar !== avatar || ctx().groupId)
            throw new Error('Character changed while restoring the embedded game.');
    };
    try {
        if (explicit) {
            if (document.querySelector('#chat .edit_textarea'))
                throw new Error('Finish or cancel the open message edit before restoring another chat.');
            const before = JSON.stringify({ messages: context.chat, metadata: initialMetadata });
            await context.saveChat(); check();
            if (ctx().chatMetadata !== initialMetadata || ctx().chatId !== context.chatId)
                throw new Error('Chat changed before saving. The embedded game was not opened.');
            const saved = await fetch('/api/chats/get', { method: 'POST', headers: context.getRequestHeaders(),
                body: JSON.stringify({ ch_name: character.name, avatar_url: avatar, file_name: context.chatId }) });
            if (!saved.ok) throw new Error('Could not verify the current chat save. The current chat was kept open.');
            const rows = await saved.json(); check();
            if (ctx().chatMetadata !== initialMetadata || ctx().chatId !== context.chatId
                || before !== JSON.stringify({ messages: context.chat, metadata: initialMetadata })
                || !Array.isArray(rows) || before !== JSON.stringify({ messages: rows.slice(1), metadata: rows[0]?.chat_metadata }))
                throw new Error('The current chat save could not be verified. The current chat was kept open.');
            savedCurrentChat = before;
        }
        const metadata = structuredClone(game.metadata || {}); delete metadata[OWNER];
        metadata.integrity = crypto.randomUUID();
        // Reuse an identical linked native book; a second book name would activate
        // every copied profile twice. Different existing books are never overwritten.
        const linked = character.data?.extensions?.world;
        const embeddedChatLore = game.worldInfo?.data;
        const linkedBook = nativeWI.world_names?.includes(linked) ? await nativeWI.loadWorldInfo(linked) : null;
        check();
        const embeddedLore = embeddedChatLore?.entries ? embeddedChatLore
            : !linkedBook && character.data?.character_book?.entries?.length ? nativeWI.convertCharacterBook(character.data.character_book) : null;
        const bookSignature = book => JSON.stringify(Object.values(book.entries || {}).map(entry => profileSignature(entry, null)).sort());
        if (embeddedLore && linkedBook && bookSignature(embeddedLore) === bookSignature(linkedBook)) {
            metadata.world_info = linked;
        } else if (embeddedLore) {
            const name = `WorldMemory_CardLore_${crypto.randomUUID()}`;
            if (!await nativeWI.createNewWorldInfo(name, { interactive: false })) throw new Error('Could not restore embedded author WI.');
            check(); await nativeWI.saveWorldInfo(name, structuredClone(embeddedLore), true);
            check(); metadata.world_info = name;
        } else if (metadata.world_info && !nativeWI.world_names?.includes(metadata.world_info)) delete metadata.world_info;
        if (!nativeWI.world_names?.includes(linked) && metadata.world_info) {
            const card = await readCharacterCard(avatar); check();
            await writeCardExtensions(avatar, card, { ...card.data.extensions, world: metadata.world_info }); check();
        }
        if (ctx().chatMetadata !== initialMetadata) throw new Error('Chat changed before the embedded game import.');
        const resumeId = crypto.randomUUID();
        metadata.worldMemoryCardImport = { avatar, resumeId, importedAt: Date.now() };
        const header = { user_name: context.name1, character_name: character.name,
            create_date: new Date().toISOString(), chat_metadata: metadata };
        const text = [header, ...game.messages].map(value => JSON.stringify(value)).join('\n') + '\n';
        const form = new FormData();
        form.append('avatar', new File([text], 'WorldMemory-Game.jsonl', { type: 'application/jsonl' }));
        form.append('file_type', 'jsonl'); form.append('avatar_url', avatar);
        form.append('character_name', character.name); form.append('user_name', context.name1);
        const response = await fetch('/api/chats/import', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`Embedded chat import failed (HTTP ${response.status}).`);
        const result = await response.json(); check();
        if (!result.res || result.fileNames?.length !== 1) throw new Error('ST could not import the embedded chat.');
        if (ctx().chatMetadata !== initialMetadata) throw new Error('Chat changed. The imported game remains in this character\'s chat list.');
        if (explicit && (document.querySelector('#chat .edit_textarea')
            || savedCurrentChat !== JSON.stringify({ messages: context.chat, metadata: initialMetadata })))
            throw new Error('Current chat changed during import and was kept open. The imported game is in this character\'s chat list.');
        const importedChatId = result.fileNames[0].replace(/\.jsonl$/, '');
        // Native openCharacterChat saves the character editor form. Finish the
        // current selection first, so an old/deleted avatar cannot be submitted.
        await ctx().selectCharacterById(ctx().characterId); check();
        if (document.getElementById('avatar_url_pole')?.value !== avatar)
            throw new Error('Character editor is still changing. The imported game remains in this character\'s chat list. Reopen the character before restoring it.');
        await ctx().openCharacterChat(importedChatId); check();
        if (ctx().chatId !== importedChatId || ctx().chatMetadata.worldMemoryCardImport?.resumeId !== resumeId)
            throw new Error('Chat changed. The embedded game remains in this character\'s chat list; its memory was not applied elsewhere.');
        busy = false;
        if (!await importBackup(backup)) throw new Error('Chat restored, but its memory needs Read memory from card.');
        status('Game restored from one PNG: original chat, complete memory and World Info. Ready to continue.');
        return true;
    } finally { restoringCardGame = false; busy = false; renderBusy(); }
}

function interceptNativeCardExport(event) {
    const target = event.target instanceof Element ? event.target.closest('.export_format') : null;
    if (!target || !['png', 'json'].includes(target.dataset.format) || !settings().enabled || !state() || ctx().groupId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const avatar = selectedCardAvatar(), format = target.dataset.format;
    void (async () => {
        if (busy || archiveRuntime.isBusy()) throw new Error('Wait for the current memory operation before exporting the game.');
        // ST's PNG metadata decoder builds a string one character at a time.
        // Assemble the complete download in the browser: a full game must never
        // pass through native character edit/export on a phone's server heap.
        if (document.getElementById('avatar_url_pole')?.value !== avatar)
            await ctx().selectCharacterById(ctx().characterId);
        if (selectedCardAvatar() !== avatar || document.getElementById('avatar_url_pole')?.value !== avatar)
            throw new Error('Character editor changed before card export.');
        if (busy || archiveRuntime.isBusy()) throw new Error('Wait for the current memory operation before exporting the game.');
        const context = ctx(), metadata = context.chatMetadata, character = context.characters[context.characterId];
        busy = true; controller = new AbortController(); clearTimeout(timer); renderBusy();
        const check = () => {
            controller.signal.throwIfAborted();
            if (ctx().chatMetadata !== metadata || ctx().chat !== context.chat || selectedCardAvatar() !== avatar)
                throw new Error('Chat or character changed before card export.');
        };
        try {
            const card = portableCard(character.json_data ? JSON.parse(character.json_data) : character);
            const form = new FormData(document.getElementById('form_create'));
            for (const [field, native] of Object.entries({ name: 'ch_name', description: 'description', personality: 'personality',
                scenario: 'scenario', first_mes: 'first_mes', mes_example: 'mes_example', creator_notes: 'creator_notes',
                system_prompt: 'system_prompt', post_history_instructions: 'post_history_instructions', creator: 'creator', character_version: 'character_version' })) {
                if (!form.has(native)) continue;
                card.data[field] = String(form.get(native));
                if (['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].includes(field)) card[field] = card.data[field];
            }
            card.data.alternate_greetings = structuredClone(character.data.alternate_greetings || []);
            if (form.has('tags')) card.tags = card.data.tags = String(form.get('tags')).split(',').map(tag => tag.trim()).filter(Boolean);
            card.fav = false; card.data.extensions ??= {}; card.data.extensions.fav = false;
            card.data.extensions.worldMemoryBackup = await prepareCardBackup(context, check);
            // Old ST cards can have a second top-level extensions object.
            // Carry one snapshot only; data.extensions is the canonical V2/V3 path.
            if (card.extensions) delete card.extensions.worldMemoryBackup;
            let blob;
            if (format === 'png') {
                const response = await fetch(`/characters/${encodeURIComponent(avatar)}`, { cache: 'no-store' }); check();
                if (!response.ok) throw new Error(`Could not read the character cover (HTTP ${response.status}).`);
                blob = portablePng(await response.arrayBuffer(), card); check();
            } else blob = new Blob([JSON.stringify(card, null, 2)], { type: 'application/json' });
            check();
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = avatar.replace(/\.png$/i, `.${format}`); link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            $('#export_format_popup').hide();
            status('Complete game exported: chat, memory, outline and WI.');
        } finally { controller = null; busy = false; renderBusy(); }
    })().catch(error => {
        status(error.message); toastr.warning(error.message, 'World Memory');
    });
}

async function init() {
    const freshProfile = !ctx().extensionSettings[OWNER];
    nativeWI = await import('/scripts/world-info.js'); settings();
    if (!freshProfile) {
        // Native WI may have been changed while this addon was disabled or in another tab.
        // Reflect that manual choice on load instead of restoring an older addon cap.
        const cap = Math.max(0, Number(nativeWI.world_info_budget_cap) || 0), s = settings();
        s.wiActivationUnlimited = cap === 0;
        if (cap > 0) s.wiActivationTokens = cap;
    }
    $('#extensions_settings2').append(await ctx().renderExtensionTemplateAsync('third-party/Extension-WorldMemory', 'settings', {}));
    getArchive();
    if (await claimArchiveRuntime()) return;
    archiveRuntime = installArchiveRuntime({ ctx,
        settings: () => ({ ...settings(), wiDiffs: diffMode(), archiveAuto: !busy && settings().archiveAuto !== false }), getArchive, saveArchive, status,
        prepareReferences: prepareSummaryContext, prepareKnowledge: options => knowledgeRuntime?.context(options),
        refreshInjection: () => history?.refresh(), onBusyChange: renderBusy, onRequest: renderSummaryPrompts,
        afterSave: async () => { history?.changed(); await update(false); await renderArchive(); } });
    wiDiffRuntime = createWIDiffRuntime({ ctx, snapshot: options => archiveRuntime.snapshot(options),
        getBook, saveBook, initializeEntry, saveState });
    history = installHistory({ ctx, settings, state, saveState, status, bridge });
    semanticWI = createSemanticWIRuntime({ ctx, settings, embeddings: history.embeddings,
        sourceQueries: getSummaryWorldInfoSources, sourceSignal: getSummaryWorldInfoSignal, onUpdate: renderWIStatus });
    knowledgeRuntime = createKnowledgeRuntime({ ctx, settings, snapshot: () => archiveRuntime.snapshot(),
        getBook: () => getBook(), world: () => state()?.book, owner: () => state()?.owner });
    const prepareContext = async (...args) => {
        const results = await Promise.allSettled([history.prepare(...args), semanticWI.prepare(...args)]);
        for (const result of results) if (result.status === 'rejected') {
            console.warn('[WorldMemory] Optional context preparation failed.', result.reason);
            status('Some memory preparation was unavailable. Native chat and WI keys remain active.');
        }
    };
    globalThis.worldMemoryPrepareHistory = prepareContext;
    document.addEventListener('click', interceptNativeCardExport, true);
    $('#wm_apply_recommended').on('click', () => {
        if (busy || archiveRuntime.isBusy()) return;
        const s = settings();
        const recommended = recommendContextBudget(s.promptTargetTokens, { historyBaselineTokens: lastContextStatistics?.history.baselineTokens || 0 });
        Object.assign(s, recommended, { enabled: true, history: true, hints: true, historySemantic: true, wiSemantic: false, historyEmbeddingMode: 'api',
            injectionPosition: 0, historySpineRerank: false, knowledgeBoundaries: false, awarenessGraph: false });
        s.historyEmbeddingAPI = { ...s.historyEmbeddingAPI, model: 'gemini-embedding-2-preview', revision: 'gemini-embedding-2-preview', dimensions: 768, transport: 'google-native' };
        void applySettings({ nativeWIBudget: true }).then(() => status('Recommendations applied for the chosen context. All allowances remain editable; connection URLs and keys were kept.')).catch(error => status(error.message));
    });
    archiveRuntime.setHistoryProvider(() => history.inspect()?.text || '');
    installWorldInfoTracking(ctx());
    populateProfileDropdown(document.getElementById('wm_connection_profile'), settings().connectionProfileId, value => {
        settings().connectionProfileId = value; void applySettings().catch(error => status(error.message));
    });
    document.getElementById('wm_embedding_mode').addEventListener('change', event => {
        settings().historyEmbeddingMode = event.target.value;
        document.getElementById('wm_embedding_api_fields').hidden = event.target.value === 'local';
        document.getElementById('wm_embedding_local_fields').hidden = event.target.value !== 'local';
        void applySettings().catch(error => status(error.message));
    });
    for (const [id, field] of [['wm_embedding_url','url'], ['wm_embedding_key','key'], ['wm_embedding_model','model'],
        ['wm_embedding_dimensions','dimensions'], ['wm_embedding_transport','transport']]) {
        document.getElementById(id).addEventListener('change', event => {
            const api = settings().historyEmbeddingAPI ??= {};
            const value = event.target.value.trim();
            if (!value) delete api[field];
            else api[field] = field === 'dimensions' ? Math.max(1, Math.floor(Number(value) || 768)) : value;
            ctx().saveSettingsDebounced(); history.changed(); semanticWI?.invalidate(); render();
        });
    }
    document.getElementById('wm_embedding_local_url').addEventListener('change', event => {
        (settings().historyEmbeddingLocal ??= {}).apiUrl = event.target.value.trim() || 'http://127.0.0.1:8081';
        ctx().saveSettingsDebounced(); history.changed(); semanticWI?.invalidate(); render();
    });
    for (const control of document.querySelectorAll('.world-memory-settings [data-setting]')) {
        if (control.id === 'wm_connection_profile') continue; // native profile lifecycle owns this listener
        control.addEventListener('change', () => {
            if (control.dataset.setting === 'wiDiffs' && state()?.wiDiffState) {
                control.checked = true; renderBusy(); status(diffStatus()); return;
            }
            if (control.id === 'wm_injection_position') {
                const s = settings(), selected = control.value;
                if (s.injectionPosition === 1 && s.injectionDepth > 0) s.injectionInsideDepth = s.injectionDepth;
                s.injectionPosition = selected === 'chat_end' ? 1 : Number(selected);
                if (selected === 'chat_end') s.injectionDepth = 0;
                else if (selected === '1' && s.injectionDepth === 0) s.injectionDepth = s.injectionInsideDepth || 1;
                void applySettings().catch(error => status(error.message));
                return;
            }
            let value = control.type === 'checkbox' ? control.checked : control.value;
            if (control.type === 'number') value = Math.max(Number(control.min || 0), Number(value) || 0);
            if (control.tagName === 'SELECT' && typeof defaults[control.dataset.setting] === 'number') value = Number(value);
            if (control.id === 'wm_injection_depth' && settings().injectionDepth > 0) settings().injectionInsideDepth = settings().injectionDepth;
            settings()[control.dataset.setting] = value;
            if (SUMMARY_PROMPT_KEYS.includes(control.dataset.setting)) rememberPromptOrigin(settings(), control.dataset.setting);
            void applySettings({ nativeWIBudget: ['wiActivationTokens', 'wiActivationUnlimited'].includes(control.dataset.setting) }).catch(error => status(error.message));
        });
    }
    $('#world_info_budget_cap, #world_info_budget_cap_counter').on('input.worldMemory', event => {
        const cap = Math.max(0, Number(event.target.value) || 0), s = settings();
        s.wiActivationUnlimited = cap === 0;
        if (cap > 0) s.wiActivationTokens = cap;
        wiSize = null; wiMeasurementSerial++; ctx().saveSettingsDebounced();
        void render().catch(error => status(error.message));
    });
    document.getElementById('wm_main_names').addEventListener('change', async event => {
        if (!state()) return;
        state().mainNames = names(event.target.value); await saveState();
        status('Main character names saved. They are tracked in the next L0 request; Update legacy WI can refresh older profiles.');
    });
    $('#wm_update').on('click', () => { void update(true); });
    $('#wm_card_wi').on('change', () => { void selectChatWI().catch(error => {
        status(error.message); toastr.warning(error.message, 'World Memory');
    }); });
    $('#wm_prompt_preview_stage, #wm_prompt_request').on('change', renderSummaryPrompts);
    $('#wm_reset_summary_prompts').on('click', () => {
        if (busy || archiveRuntime.isBusy()) return;
        resetSummaryPrompts(settings());
        ctx().saveSettingsDebounced(); renderSummaryPrompts();
        status('Stage 1 now uses the displayed built-in WorldMemory prompts. Stage 2 was not changed.');
    });
    $('#wm_retry_saved_wi').on('click', () => { void update(false, true); });
    $('#wm_review_diff').on('click', () => { void reviewLastWIDiff(); });
    $('#wm_retry_diff_review').on('click', () => { void reviewLastWIDiff({ savedOnly: true }); });
    $('#wm_reparse_response').on('click', () => { void backfillMetadata({ force: true, savedResponsesOnly: true }); });
    $('#wm_wi_diagnostics').on('click', () => { void downloadWIDiagnostics().catch(error => status(error.message)); });
    $('#wm_export_all').on('click', () => { void exportEverything().catch(error => status(error.message)); });
    $('#wm_import_all').on('click', () => document.getElementById('wm_import_all_file').click());
    $('#wm_import_all_file').on('change', async event => {
        try { if (event.target.files[0]) await importEverything(event.target.files[0]); }
        catch (error) { status(error.message); toastr.warning(error.message, 'WorldMemory · импорт всего'); }
        finally { event.target.value = ''; }
    });
    $('#wm_backfill_metadata').on('click', () => {
        const repeat = document.getElementById('wm_repeat_metadata'), force = repeat.checked;
        repeat.checked = false;
        void backfillMetadata({ force });
    });
    $('#wm_backfill_spine').on('click', () => { void backfillSpine(); });
    $('#wm_coverage_prepare').on('click', () => { void backfillMetadata(); });
    $('#wm_coverage_apply').on('click', () => { void update(false, true); });
    $('#wm_coverage_spine').on('click', () => { void backfillSpine(); });
    $('#wm_coverage_stop').on('click', () => { $('#wm_stop').trigger('click'); });
    $('[data-coverage-filter]').on('click', event => { coverageFilter = event.currentTarget.dataset.coverageFilter; renderCoverage(); });
    $('#wm_stop').on('click', () => { clearTimeout(timer); controller?.abort(); archiveRuntime.stop(); history.stop(); semanticWI.invalidate(); renderBusy(); });
    $('#wm_summarize').on('click', () => { void archiveRuntime.summarizeNow().then(renderArchive).catch(error => status(error.message)).finally(renderBusy); });
    $('#wm_clear_embeddings').on('click', async () => {
        if (busy || archiveRuntime.isBusy()) return;
        history.stop(); semanticWI.invalidate();
        try {
            const result = await history.embeddings.clearCache();
            status(result.storage === 'indexeddb' ? 'Embedding cache cleared. Saved memory and WI are unchanged.'
                : 'In-memory vectors cleared. Browser persistent storage is unavailable; saved memory and WI are unchanged.');
        } catch (error) { status(error.message); }
    });
    $('#wm_open, #wm_open_wi_result').on('click', () => { if (state()?.book) nativeWI.openWorldInfoEditor(state().book); else status('Update memory first to create the book.'); });
    $('#wm_export').on('click', async () => {
        try { if (!busy && !archiveRuntime.isBusy()) download('world-memory-backup.json', await exportBackup()); }
        catch (error) { status(error.message); toastr.warning(error.message, 'World Memory'); }
    });
    $('#wm_card_save').on('click', () => { void saveMemoryToCard().catch(error => { status(error.message); toastr.warning(error.message, 'World Memory'); }); });
    $('#wm_card_load').on('click', () => { void loadMemoryFromCard().catch(error => { status(error.message); toastr.warning(error.message, 'World Memory'); }); });
    $('#wm_card_resume').on('click', () => { void restoreCardGame(true).catch(cardRestoreError); });
    $('#wm_import').on('click', () => document.getElementById('wm_import_file').click());
    $('#wm_import_file').on('change', async event => {
        const file = event.target.files[0];
        try { if (file) await importBackup(async () => JSON.parse(await file.text())); }
        catch (error) { status(error.message); toastr.warning(error.message, 'World Memory'); }
        finally { event.target.value = ''; }
    });
    const events = ctx().eventTypes || ctx().event_types;
    // Runs before RussianWI's normal listener, so it can expand the new ordinary keys too.
    ctx().eventSource.makeFirst(events.WORLDINFO_ENTRIES_LOADED, injectBook);
    ctx().eventSource.on(events.WORLDINFO_SCAN_DONE, async args => {
        if (args?.state?.next || getSummaryWorldInfoSources() || nativeReferenceScope) return;
        const duplicates = settings().enabled && args?.activated?.entries ? removeDuplicateProfiles(args.activated.entries, nativeWI.world_info_use_group_scoring) : [];
        const scene = settings().enabled && args?.activated?.entries ? placeSceneProfiles({ activated: args.activated.entries,
            catalogue: args.sortedEntries || [], chat: history?.sceneChat() || ctx().chat, mainNames: state()?.mainNames || [],
            parseRegex: nativeWI.parseRegexFromString, substitute: ctx().substituteParams,
            caseSensitive: nativeWI.world_info_case_sensitive, atDepth: nativeWI.world_info_position.atDepth,
            isActivationReason: key => semanticWI?.isActivationReason(key) }) : [];
        lastNativeWIScan = { metadata: ctx().chatMetadata, scene, duplicates, entries: [...(args?.activated?.entries?.values?.() || [])]
            .map(entry => ({ uid: entry.uid, title: entry.comment, world: entry.world, constant: entry.constant })) };
        renderWIStatus();
        const metadata = ctx().chatMetadata, text = args?.activated?.text || '', measurement = wiMeasurementSerial;
        const measured = text ? await countTextTokens(text, ctx()) : 0;
        if (ctx().chatMetadata === metadata && measurement === wiMeasurementSerial && !getSummaryWorldInfoSources() && !nativeReferenceScope) {
            wiSize = { metadata, tokens: measured }; scheduleContextStatistics();
        }
    });
    ctx().eventSource.on('worldmemory:prompt-size', info => { nativePromptSize = { metadata: ctx().chatMetadata, info }; scheduleContextStatistics(); });
    ctx().eventSource.on('worldmemory:archive-changed', event => { if (event.metadata === ctx().chatMetadata) { history.changed(); schedule(); scheduleContextStatistics(); } });
    ctx().eventSource.on(events.CHAT_CHANGED, async () => {
        clearTimeout(cardRestoreTimer);
        clearTimeout(timer); controller?.abort(); getArchive();
        try {
            if (await restoreEmbeddedCardGame()) return;
            await claimArchiveRuntime(); await Promise.all([render(), renderArchive()]);
        } catch (error) { cardRestoreError(error); }
    });
    for (const event of [events.MESSAGE_EDITED, events.MESSAGE_SWIPED, events.MESSAGE_DELETED].filter(Boolean)) ctx().eventSource.on(event, () => {
        clearTimeout(timer); controller?.abort(new Error('Chat sources changed.'));
        history?.changed(); semanticWI?.invalidate();
        return cleanupSourceChanges().then(() => renderArchive()).catch(error => status(error.message));
    });
    ctx().eventSource.on(events.WORLDINFO_UPDATED, () => { if (!busy) void render().catch(error => status(error.message)); });
    await render(); await renderArchive();
    if (freshProfile) applyNativeWIBudget();
    try {
        if (!await restoreEmbeddedCardGame()) status('Ready. Growing L0 archive; raw tail and recovered-history budgets are separate. No layer transfers.');
    } catch (error) { cardRestoreError(error); }
    globalThis.WorldMemory = Object.freeze({ version: VERSION, update: () => update(true), stop: () => { controller?.abort(); archiveRuntime.stop(); history.stop(); semanticWI.invalidate(); },
        archive: archiveRuntime, summarizeNow: archiveRuntime.summarizeNow, inspectSummaryPrompts: () => archiveRuntime.inspectPrompts(),
        backfillMetadata, prepareSummaryContext, retrySavedWI: () => update(false, true), reviewLastWIDiff, reviewWIDiff: reviewLastWIDiff,
        retrySavedDiffReview: () => reviewLastWIDiff({ savedOnly: true }), inspectWIDiff: () => structuredClone(state()?.wiDiffState || null),
        prepareHistory: prepareContext, inspectHistory: () => history.inspect(), inspectSemanticWI: () => semanticWI.inspect(),
        inspectKnowledge: () => knowledgeRuntime.inspect(), inspectContextBudget: () => lastContextStatistics ? structuredClone(lastContextStatistics) : null,
        getStatus: () => ({ busy, book: state()?.book || null, enabled: settings().enabled,
            history: Boolean(settings().enabled && settings().injectionPosition !== -1),
            summaryWI: Boolean(settings().enabled && settings().auto),
            wiDiffs: diffMode(), wiDiffPending: state()?.wiDiffState?.pending?.id || null,
            summaryMetadata: Boolean(settings().enabled && (settings().history || settings().auto)),
            wiPending: Object.values(state()?.wiPackets || {}).filter(item => item.status !== 'applied').length }) });
}
init().catch(error => { console.error('[World Memory]', error); status(error.message); toastr.warning(error.message, 'World Memory'); });
