import { VERSION, OWNER, SYSTEM, normalize, signature, entryMeta, fingerprint, packetSignature, sourceLabel,
    parseResult, ownedEntries, retainedFacts, detectManual, markGenerated, formatContent,
    readSummaryWI, evidenceRevision, compactRevision, retainedContent, SUMMARY_WI_SYSTEM } from './memory.js';
import { installHistory } from './history-runtime.js';
import { createArchive, importLegacyArchive } from './archive-store.js';
import { installArchiveRuntime } from './archive-runtime.js';
import { createSemanticWIRuntime } from './semantic-wi-runtime.js';
import { sourceId } from './vendor/summaryception/summary-sources.js';
import { installWorldInfoTracking, collectSummaryWorldInfo, summaryWorldInfoBudget, getSummaryWorldInfoSources, getSummaryWorldInfoSignal } from './vendor/summaryception/world-info-context.js';
import { populateProfileDropdown } from './vendor/summaryception/connectionutil.js';
import { restoreAutomaticGhosts } from './vendor/summaryception/context-control.js';

const defaults = { enabled: true, auto: true, alwaysMain: true, language: 'auto', targetTokens: 160,
    detailTokens: 4000, referenceTokens: 6000, responseTokens: 0, position: 4, depth: 2,
    history: true, hints: true, historySemantic: true, historyEmbeddingMode: 'api', wiSemantic: false, wiSemanticTopK: 6, wiSemanticThreshold: 0.45,
    historyMaxTokens: 8000, promptTargetTokens: 24000, retainedContextTokens: 8000, batchContextTokens: 24000, blindZoneExchanges: 1,
    ghostUserMessages: true, ghostAssistantMessages: true, reapplyGhostingOnSummary: false, pauseSummarization: false,
    connectionSource: 'default', connectionProfileId: '', summarizerStreaming: false, summarizerResponseLength: 0,
    openaiUrl: '', openaiKey: '', openaiModel: '', openaiMaxTokens: 0, ollamaUrl: 'http://localhost:11434', ollamaModel: '', ollamaMaxTokens: 0,
    summaryLanguage: 'en', summaryCustomLanguage: '', summarizerWorldInfo: true, summarizerWorldInfoPercent: 20,
    injectionPosition: 0, injectionDepth: 1, injectionRole: 0, injectionScan: false, injectionTemplate: '[Earlier history]\n{{summary}}' };
let nativeWI, controller = null, busy = false, timer = null, currentUpdate = null;
let history, archiveRuntime, semanticWI;
let nativeReferenceScope = null;
const ctx = () => SillyTavern.getContext();
const bridge = () => archiveRuntime;
const status = text => { const node = document.getElementById('wm_status'); if (node) node.textContent = text; renderBusy(); };
const settings = () => {
    const value = ctx().extensionSettings[OWNER] ??= {};
    if (!value.archiveConfigVersion) {
        const previous = ctx().extensionSettings.summaryception || {};
        for (const key of ['retainedContextTokens','batchContextTokens','blindZoneExchanges','ghostUserMessages','ghostAssistantMessages',
            'reapplyGhostingOnSummary','pauseSummarization','connectionSource','connectionProfileId','summarizerStreaming','summarizerResponseLength',
            'openaiUrl','openaiKey','openaiModel','openaiMaxTokens','ollamaUrl','ollamaModel','ollamaMaxTokens','summaryLanguage','summaryCustomLanguage',
            'summarizerWorldInfo','summarizerWorldInfoPercent','summarizerSystemPrompt','summarizerUserPrompt','stripPatterns',
            'injectionPosition','injectionDepth','injectionRole','injectionScan','injectionTemplate']) {
            if (value[key] === undefined && previous[key] !== undefined) value[key] = structuredClone(previous[key]);
        }
        value.historyMaxTokens ??= (Number(value.historyBaseTokens) || 4000) + (Number(value.historyZoomTokens) || 4000);
        value.archiveConfigVersion = 1; value.history = true;
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
const tokens = text => ctx().getTokenCountAsync(text, 0);
const names = value => [...new Set(value.split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
function unchanged(metadata) {
    controller?.signal.throwIfAborted();
    if (ctx().chatMetadata !== metadata) throw new Error('Chat changed. The result was not written to the new chat.');
}
async function getBook(create = false) {
    const memory = state();
    if (!memory) throw new Error('Open a character chat first.');
    if (!memory.book && !create) return null;
    if (!memory.book) {
        const name = `WorldMemory_${memory.owner}`;
        await nativeWI.createNewWorldInfo(name, { interactive: false });
        let data = memory.cloneFrom ? await nativeWI.loadWorldInfo(memory.cloneFrom) : null;
        data = data ? structuredClone(data) : { entries: {} };
        if (memory.cloneFrom) {
            for (const [id, entry] of Object.entries(data.entries || {})) {
                if (entryMeta(entry)) entryMeta(entry).owner = memory.owner;
            }
        }
        memory.book = name; delete memory.cloneFrom;
        await nativeWI.saveWorldInfo(name, data, true);
        await saveState();
    }
    const data = await nativeWI.loadWorldInfo(memory.book);
    if (!data) throw new Error(`World Memory book is missing: ${memory.book}. Import its backup or choose a new chat.`);
    return structuredClone(data);
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
    await nativeWI.saveWorldInfo(name, book, true);
    check();
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
    entry.extensions[OWNER] = { owner: state().owner, type, main, contributions: {}, manual: false };
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
    const memory = state();
    if (!settings().enabled || !memory?.book) return;
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
        if (!entry.content?.trim() || present.has(`${world}.${entry.uid}`)) continue;
        payload.chatLore.push({ ...structuredClone(entry), world });
    }
}

async function model(systemPrompt, prompt, metadata) {
    unchanged(metadata);
    let timeout;
    const activity = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller?.abort(new Error('No response data for 120 seconds. Saved WI was kept.')), 120000);
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
    const metadata = ctx().chatMetadata;
    let identity = null;
    const guard = () => {
        signal?.throwIfAborted();
        if (ctx().chatMetadata !== metadata) throw new Error('Chat changed while preparing WI context.');
        if (identity && (state()?.owner !== identity.owner || state()?.book !== identity.book)) throw new Error('The WI book changed while preparing references.');
    };
    try {
        guard();
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
            if (detectManual(entry)) continue;
            const row = { uid: entry.uid, name: entry.comment, retained_facts: retainedFacts(entry, omit).map(({ order, facts }) => ({ order, facts })) };
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
                    excludeBooks: [scope.book], signal,
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
            stamp: { version: 1, owner: identity.owner, book: identity.book, omittedPacketId: omit, referenceUIDs, entryRevisions } };
    } catch (error) {
        if (signal?.aborted) throw error;
        status(`WI context unavailable: ${error.message} L0 can still be saved. Retry saved WI or Update legacy WI.`);
        return null;
    }
}
function summaryRequest(packet, book) {
    const updates = readSummaryWI(packet.memoryMetadata?.wi);
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
        const manual = detectManual(entry);
        if (entryMeta(entry).contributions[packet.id] && (savedWI || !samePacket || revisedUids.has(entry.uid))) {
            delete entryMeta(entry).contributions[packet.id]; affected.add(entry.uid);
        }
        if (manual) affected.delete(entry.uid);
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
    const snapshot = bridge().snapshot(), metadata = snapshot.metadata;
    if (!snapshot.chatId) { status('Open a character chat first.'); return; }
    busy = true; controller = new AbortController(); renderBusy();
    try {
        let book = await getBook(!cleanupOnly);
        if (!book) return;
        if (!cleanupOnly) {
            const beforeNames = structuredClone(book); syncMainNames(book);
            book = await saveBook(book, metadata, beforeNames);
        }
        const current = new Set(snapshot.packets.map(packet => packet.id));
        await history.prune(snapshot);
        const tracked = new Set([...Object.keys(state().packets), ...ownedEntries(book, state().owner)
            .flatMap(entry => Object.keys(entryMeta(entry).contributions || {}))]);
        const removed = [...tracked].filter(id => !current.has(id));
        book = await removePackets(book, removed, snapshot.packets, metadata, { local: !force });
        for (const id of Object.keys(state().wiPackets)) if (!current.has(id)) delete state().wiPackets[id];
        // A deleted/edited/regenerated source must stop contributing even if its optional replacement WI failed.
        const revised = snapshot.packets.filter(packet => tracked.has(packet.id) && (packet.stale
            || (state().packets[packet.id] && state().packets[packet.id] !== packetSignature(packet))
            || ownedEntries(book, state().owner).some(entry => {
                const saved = entryMeta(entry).contributions[packet.id]?.packetRevision;
                return saved && saved !== compactRevision(packetSignature(packet));
            }))).map(packet => packet.id);
        book = await removePackets(book, revised, snapshot.packets, metadata, { local: true, preserveEmpty: true });
        const attemptSignature = packet => compactRevision([packetSignature(packet), packet.memoryMetadata?.wi || null, packet.memoryMetadata?.wiContext || null]);
        for (const packet of snapshot.packets.filter(packet => packet.stale)) state().wiPackets[packet.id] = {
            revision: attemptSignature(packet), status: 'stale', message: 'Original sources changed. Regenerate the affected L0; old automatic contributions were removed.' };
        if (cleanupOnly) { await saveState(); return; }
        const pending = snapshot.packets.filter(packet => !packet.stale && (force
            || state().wiPackets[packet.id]?.revision !== attemptSignature(packet)
            || (retrySaved && state().wiPackets[packet.id]?.status !== 'applied')));
        for (let i = 0; i < pending.length; i++) {
            unchanged(metadata); status(`Updating packet ${i + 1} / ${pending.length} · source ${sourceLabel(pending[i])}`);
            const packet = pending[i], revision = attemptSignature(packet);
            const saved = Boolean(packet.memoryMetadata?.wi);
            if (!saved && !force) {
                state().wiPackets[packet.id] = { revision, status: 'pending', message: 'No saved WI updates. Refine this L0 or use Update legacy WI.' };
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
        const wiPending = Object.values(state().wiPackets).filter(item => item.status !== 'applied');
        status(stale ? `${stale} L0 packet(s) have changed sources. Their old automatic WI contributions were removed; regenerate those L0s.`
            : `Updated · ${ownedEntries(book, state().owner).length} records from ${Object.keys(state().packets).length} L0 packets. Saved WI applies without another model request.${waiting ? ` ${waiting} main profile(s) await played evidence.` : ''}${wiPending.length ? ` ${wiPending.length} WI result(s) pending: ${wiPending[0].message} Retry saved WI makes no model request.` : ''}${historyErrors ? ` ${historyErrors} packet(s) need optional history markup; saved L0 is retained.` : ''}`);
    } catch (error) {
        if (cleanupOnly) throw error;
        console.error('[World Memory]', error);
        status(controller?.signal.aborted ? 'Stopped. Already saved packets were kept.' : error.message);
        if (!controller?.signal.aborted) toastr.warning(error.message, 'World Memory');
    } finally { controller = null; busy = false; renderBusy(); await render(); }
}
async function backfillMetadata() {
    if (busy) return;
    if (!bridge()?.backfillMemoryMetadata) { status('Archive runtime is not ready. Reload ST.'); return; }
    if (!ctx().chatId) { status('Open a character chat first.'); return; }
    if (bridge().isBusy()) { status('Wait for the active request or press Stop.'); return; }
    clearTimeout(timer);
    try {
        // The archive writer owns its reservation/controller. WI references can
        // still be prepared locally; they must not see a self-imposed WI busy.
        const result = await bridge().backfillMemoryMetadata({ responseTokens: settings().responseTokens,
            onProgress: progress => status(`Building L′ / search excerpts ${progress.saved + 1} / ${progress.total} · ${progress.sourceStatus === 'summary-only' ? 'summary only; originals unavailable or changed' : 'complete original packet'}`) });
        status(result.total ? `Saved metadata for ${result.saved} L0 packet(s). ${result.summaryOnly} summary-only. ${result.warnings} with ignored excerpts. L0 text was kept.`
            : 'All saved L0 packets already have current L′ / search metadata.');
    } catch (error) {
        status(error.message); if (error.name !== 'AbortError') toastr.warning(error.message, 'World Memory');
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
    $('#wm_update, #wm_retry_saved_wi, #wm_backfill_metadata, #wm_summarize').prop('disabled', working);
    $('#wm_archive button, #wm_import, #wm_enabled, #wm_clear_embeddings').prop('disabled', working);
    $('#wm_stop').prop('disabled', !working);
}
function button(text, callback) {
    const node = document.createElement('button'); node.className = 'menu_button'; node.textContent = text;
    node.addEventListener('click', () => Promise.resolve(callback()).catch(error => status(error.message))); return node;
}
async function renderArchive() {
    const container = document.getElementById('wm_archive'), label = document.getElementById('wm_archive_status');
    if (!container || !archiveRuntime) return;
    const snapshot = archiveRuntime.snapshot({ effective: false });
    const records = snapshot.packets, stale = records.filter(record => record.stale);
    const incomplete = record => record.annotationStatus === 'pending' || record.annotationStatus === 'partial' || Boolean(record.annotationError);
    label.textContent = `${records.length} saved records · ${stale.length} changed source set(s) · ${records.filter(incomplete).length} need search notes / WI. Archive size is independent of the history request target.`;
    container.replaceChildren();
    const metadata = ctx().chatMetadata;
    for (const record of records.slice().reverse()) {
        const panel = document.createElement('details'); panel.className = 'wm-record';
        const title = document.createElement('summary');
        const linked = record.sources || [];
        const at = linked.length ? `messages ${linked[0].index}–${linked.at(-1).index}` : 'originals unavailable';
        title.textContent = `${at} · ${record.tokenCount ?? '?'} tokens${record.manual ? ' · manual' : ''}${record.stale ? ' · SOURCES CHANGED' : ''}${incomplete(record) ? ' · search notes / WI incomplete' : ''}`;
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
            action('Regenerate', () => archiveRuntime.regenerate(record.id)),
            action('Refine', () => archiveRuntime.refine(record.id)),
            action('Rebuild search notes / WI', () => archiveRuntime.backfillMemoryMetadata({ packetId: record.id, force: true })),
            action('Delete', () => archiveRuntime.remove(record.id)));
        panel.append(title);
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
        panel.append(text, sourceDetails, actions); container.append(panel);
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
async function render() {
    const memory = state(), s = settings(), metadata = ctx().chatMetadata;
    const integration = globalThis.RussianWIForms?.getStatus?.();
    document.getElementById('wm_integration').textContent = `Archive: ${bridge()?.version || 'loading'} · Russian WI: ${integration ? integration.enabled ? integration.ready ? 'ready' : 'loading dictionary' : 'disabled' : 'not loaded (optional)'}`;
    document.getElementById('wm_book').textContent = memory?.book ? `Native book: ${memory.book}` : 'A separate chat-scoped book will be created on the first update.';
    const wiResults = Object.values(memory?.wiPackets || {}), wiPending = wiResults.filter(item => item.status !== 'applied');
    document.getElementById('wm_saved_wi_status').textContent = wiPending.length
        ? `${wiPending.length} saved WI result(s) need attention. ${wiPending[0].message} L0 is retained; Retry saved WI uses no model request.`
        : `Saved WI: ${wiResults.length} applied result(s). WI references are prepared after saving each new L0.`;
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
        if (control.type === 'checkbox') control.checked = Boolean(s[control.dataset.setting]);
        else control.value = s[control.dataset.setting] ?? '';
    }
    renderHistoryPlacement(s);
    for (const group of document.querySelectorAll('[data-connection]')) group.hidden = group.dataset.connection !== s.connectionSource;
    document.getElementById('wm_embedding_mode').value = s.historyEmbeddingMode === 'local' ? 'local' : 'api';
    document.getElementById('wm_embedding_mode').disabled = !(s.historySemantic || s.wiSemantic);
    document.getElementById('wm_summarizer_wi_percent').disabled = !s.summarizerWorldInfo;
    const api = s.historyEmbeddingAPI || {}, local = s.historyEmbeddingLocal || {};
    for (const [id, key, fallback] of [['wm_embedding_url', 'url', ''], ['wm_embedding_key', 'key', ''],
        ['wm_embedding_model', 'model', 'gemini-embedding-001'], ['wm_embedding_dimensions', 'dimensions', 768],
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
async function applySettings() {
    const s = settings(), context = ctx(), memory = state(), metadata = context.chatMetadata;
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
async function init() {
    nativeWI = await import('/scripts/world-info.js'); settings();
    $('#extensions_settings2').append(await ctx().renderExtensionTemplateAsync('third-party/Extension-WorldMemory', 'settings', {}));
    getArchive();
    if (await claimArchiveRuntime()) return;
    archiveRuntime = installArchiveRuntime({ ctx,
        settings: () => ({ ...settings(), archiveAuto: !busy && settings().archiveAuto !== false }), getArchive, saveArchive, status,
        prepareReferences: prepareSummaryContext, refreshInjection: () => history?.refresh(), onBusyChange: renderBusy,
        afterSave: async () => { history?.changed(); await update(false); await renderArchive(); } });
    history = installHistory({ ctx, settings, state, saveState, status, bridge });
    semanticWI = createSemanticWIRuntime({ ctx, settings, embeddings: history.embeddings,
        sourceQueries: getSummaryWorldInfoSources, sourceSignal: getSummaryWorldInfoSignal, onUpdate: renderWIStatus });
    const prepareContext = async (...args) => {
        const results = await Promise.allSettled([history.prepare(...args), semanticWI.prepare(...args)]);
        for (const result of results) if (result.status === 'rejected') {
            console.warn('[WorldMemory] Optional context preparation failed.', result.reason);
            status('Some memory preparation was unavailable. Native chat and WI keys remain active.');
        }
    };
    globalThis.worldMemoryPrepareHistory = prepareContext;
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
            void applySettings().catch(error => status(error.message));
        });
    }
    document.getElementById('wm_main_names').addEventListener('change', async event => {
        if (!state()) return;
        state().mainNames = names(event.target.value); await saveState();
        status('Main character names saved. They are tracked in the next L0 request; Update legacy WI can refresh older profiles.');
    });
    $('#wm_update').on('click', () => { void update(true); });
    $('#wm_retry_saved_wi').on('click', () => { void update(false, true); });
    $('#wm_backfill_metadata').on('click', () => { void backfillMetadata(); });
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
    $('#wm_open').on('click', () => { if (state()?.book) nativeWI.openWorldInfoEditor(state().book); else status('Update memory first to create the book.'); });
    $('#wm_export').on('click', async () => {
        if (!state()) return status('Open a chat to export its saved memory.');
        const saved = structuredClone(state());
        for (const packet of archiveRuntime.snapshot({ effective: false }).packets) for (const source of packet.sources) {
            saved.archive.sources[source.id] = structuredClone(source);
        }
        download('world-memory-backup.json', { format: 'world-memory-v1', version: VERSION, state: saved, book: await getBook() });
    });
    $('#wm_import').on('click', () => document.getElementById('wm_import_file').click());
    $('#wm_import_file').on('change', async event => {
        let reserved = false, context, memory, metadata, next, published = false, committed = false;
        try {
            if (busy || archiveRuntime.isBusy() || !state()) return;
            const file = event.target.files[0]; if (!file) return;
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
            const data = JSON.parse(await file.text());
            check();
            if (data.format !== 'world-memory-v1' || (!data.book?.entries && !data.state?.archive)) throw new Error('Import a World Memory backup; native lorebooks can be imported in ST World Info.');
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
            const book = data.book?.entries ? structuredClone(data.book) : null;
            if (book && (!object(book.entries) || Object.values(book.entries).some(entry => !object(entry)
                || !Number.isInteger(entry.uid) || !Array.isArray(entry.key) || entry.key.some(key => typeof key !== 'string')
                || typeof entry.comment !== 'string' || typeof entry.content !== 'string'
                || (entryMeta(entry) && !object(entryMeta(entry)))))) throw new Error('Backup contains an invalid native WI entry.');
            for (const entry of Object.values(book?.entries || {})) {
                const meta = entryMeta(entry); if (!meta) continue;
                if (!object(meta.contributions)) throw new Error('Backup managed WI contributions must be an object.');
                meta.owner = owner;
                if (foreign) { meta.manual = true; meta.contributions = {}; }
            }
            if (book) {
                // Publish the imported book with the metadata pointer. Never overwrite
                // the receiving book: a failed save still leaves the old pair recoverable.
                next.book = `WorldMemory_${owner}_import_${crypto.randomUUID()}`;
                delete next.cloneFrom;
                if (!foreign && data.state?.archive) for (const record of Object.values(next.archive.records)) {
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
            metadata[OWNER] = next; published = true;
            check(next);
            await context.saveMetadata();
            committed = true;
            history.changed();
            if (ctx().chatMetadata === metadata) {
                await render(); await renderArchive();
                status('Backup imported. Review the saved archive and source links before summarizing.');
            }
        } catch (error) {
            if (published && !committed && metadata[OWNER] === next) {
                metadata[OWNER] = memory;
                // A native save can fail after reaching the server. Keep the prepared
                // book for recovery; never delete a possible persisted metadata target.
                if (ctx().chatMetadata === metadata && ctx().chat === context.chat) {
                    try { await context.saveMetadata(); }
                    catch (restoreError) { console.error('[WorldMemory] Could not persist restored memory.', restoreError); }
                }
            }
            history?.changed(); semanticWI?.invalidate();
            status(error.message); toastr.warning(error.message, 'World Memory');
        } finally {
            if (reserved) { controller = null; busy = false; renderBusy(); }
            event.target.value = '';
        }
    });
    const events = ctx().eventTypes || ctx().event_types;
    // Runs before RussianWI's normal listener, so it can expand the new ordinary keys too.
    ctx().eventSource.makeFirst(events.WORLDINFO_ENTRIES_LOADED, injectBook);
    ctx().eventSource.on(events.WORLDINFO_SCAN_DONE, renderWIStatus);
    ctx().eventSource.on('worldmemory:archive-changed', event => { if (event.metadata === ctx().chatMetadata) { history.changed(); schedule(); } });
    ctx().eventSource.on(events.CHAT_CHANGED, () => {
        clearTimeout(timer); controller?.abort(); getArchive();
        void claimArchiveRuntime().then(() => Promise.all([render(), renderArchive()])).catch(error => status(error.message));
    });
    for (const event of [events.MESSAGE_EDITED, events.MESSAGE_SWIPED, events.MESSAGE_DELETED].filter(Boolean)) ctx().eventSource.on(event, () => {
        clearTimeout(timer); controller?.abort(new Error('Chat sources changed.'));
        history?.changed(); semanticWI?.invalidate();
        return cleanupSourceChanges().then(() => renderArchive()).catch(error => status(error.message));
    });
    ctx().eventSource.on(events.WORLDINFO_UPDATED, () => { if (!busy) void render().catch(error => status(error.message)); });
    await render(); await renderArchive(); status('Ready. Growing L0 archive; raw tail and recovered-history budgets are separate. No layer transfers.');
    globalThis.WorldMemory = Object.freeze({ version: VERSION, update: () => update(true), stop: () => { controller?.abort(); archiveRuntime.stop(); history.stop(); semanticWI.invalidate(); },
        archive: archiveRuntime, summarizeNow: archiveRuntime.summarizeNow,
        backfillMetadata, prepareSummaryContext, retrySavedWI: () => update(false, true),
        prepareHistory: prepareContext, inspectHistory: () => history.inspect(), inspectSemanticWI: () => semanticWI.inspect(),
        getStatus: () => ({ busy, book: state()?.book || null, enabled: settings().enabled,
            history: Boolean(settings().enabled),
            summaryWI: Boolean(settings().enabled && settings().auto),
            summaryMetadata: Boolean(settings().enabled && (settings().history || settings().auto)),
            wiPending: Object.values(state()?.wiPackets || {}).filter(item => item.status !== 'applied').length }) });
}
init().catch(error => { console.error('[World Memory]', error); status(error.message); toastr.warning(error.message, 'World Memory'); });
