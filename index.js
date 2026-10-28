import { VERSION, OWNER, SYSTEM, normalize, signature, entryMeta, fingerprint, packetSignature, sourceLabel,
    parseResult, ownedEntries, retainedFacts, detectManual, markGenerated, formatContent } from './memory.js';
import { installHistory } from './history-runtime.js';

const defaults = { enabled: true, auto: true, alwaysMain: true, language: 'auto', targetTokens: 160,
    detailTokens: 4000, referenceTokens: 6000, responseTokens: 4096, position: 4, depth: 2,
    history: false, hints: true, historySemantic: false, historyBaseTokens: 4000, historyZoomTokens: 4000 };
let nativeWI, controller = null, busy = false, timer = null;
let history;
const ctx = () => SillyTavern.getContext();
const bridge = () => globalThis.SummaryceptionAPI;
const status = text => { const node = document.getElementById('wm_status'); if (node) node.textContent = text; };
const settings = () => {
    const value = ctx().extensionSettings[OWNER] ??= {};
    for (const [key, initial] of Object.entries(defaults)) if (value[key] === undefined) value[key] = initial;
    return value;
};
function state() {
    if (!ctx().chatId) return null;
    const value = ctx().chatMetadata[OWNER] ??= { owner: crypto.randomUUID(), chatId: ctx().chatId, packets: {}, mainNames: [] };
    value.packets ??= {}; value.mainNames ??= [];
    if (value.chatId !== ctx().chatId) {
        // A branch or renamed chat gets an independent book; no cross-chat write-through.
        value.cloneFrom = value.book || value.cloneFrom;
        value.book = null; value.owner = crypto.randomUUID(); value.chatId = ctx().chatId;
    }
    return value;
}
const saveState = () => ctx().saveMetadata();
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
    unchanged(metadata);
    if (baseBook) {
        const current = await getBook();
        unchanged(metadata);
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
    await nativeWI.saveWorldInfo(state().book, book, true);
    unchanged(metadata);
    await saveState();
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
    if (!settings().enabled || !state()?.book) return;
    const book = await getBook();
    const present = new Set(['globalLore', 'characterLore', 'chatLore', 'personaLore']
        .flatMap(key => payload[key] || []).map(entry => `${entry.world}.${entry.uid}`));
    for (const entry of Object.values(book.entries || {})) {
        if (!entry.content?.trim() || present.has(`${state().book}.${entry.uid}`)) continue;
        payload.chatLore.push({ ...structuredClone(entry), world: state().book });
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
async function applyPacket(packet, book, packets, metadata) {
    const { updates, included } = await requestPacket(packet, book, metadata);
    unchanged(metadata);
    const current = bridge().snapshot().packets.find(item => item.id === packet.id);
    if (!current || packetSignature(current) !== packetSignature(packet)) throw new Error('The source packet changed during the request. Retry Update memory for the saved revision.');
    // Work on a clone until all requested text is available; a failed request leaves the saved book intact.
    book = await getBook();
    const next = structuredClone(book);
    const affected = new Set(); const complete = new Map();
    const samePacket = state().packets[packet.id] === packetSignature(packet);
    const revisedUids = new Set(updates.filter(update => update.facts && update.uid !== null).map(update => update.uid));
    for (const entry of ownedEntries(next, state().owner)) {
        if (detectManual(entry)) continue;
        if (entryMeta(entry).contributions[packet.id] && (!samePacket || revisedUids.has(entry.uid))) {
            delete entryMeta(entry).contributions[packet.id]; affected.add(entry.uid);
        }
    }
    for (const update of updates) {
        let entry = update.uid === null ? null : next.entries[update.uid];
        if (entry && entryMeta(entry)?.owner !== state().owner) throw new Error('The model selected a foreign entry UID. No WI was written.');
        if (update.uid !== null && !entry) throw new Error(`Unknown WI UID ${update.uid}. No WI was written.`);
        if (entry && detectManual(entry)) continue;
        if (!update.facts) continue;
        const created = !entry;
        entry ??= initializeEntry(next, update.name, update.type, update.main);
        const meta = entryMeta(entry);
        meta.type = update.type; meta.main = meta.main || update.main || state().mainNames.some(name => normalize(name) === normalize(update.name));
        meta.contributions[packet.id] = { facts: update.facts, sourceMessageIds: [...packet.sourceMessageIds], order: packet.order };
        entry.comment = update.name; entry.key = update.keys.length ? update.keys : [update.name];
        entry.constant = meta.main && settings().alwaysMain;
        affected.add(entry.uid);
        const hasLaterEvidence = retainedFacts(entry, packet.id).some(fact => fact.order > packet.order);
        if ((created || included.has(entry.uid)) && !hasLaterEvidence && update.content) complete.set(entry.uid, update.content);
    }
    const rebuild = [];
    for (const uid of affected) {
        const entry = next.entries[uid];
        if (!retainedFacts(entry).length) { delete next.entries[uid]; continue; }
        if (!complete.has(uid)) rebuild.push(entry);
    }
    for (const [uid, text] of await fold(rebuild, metadata)) complete.set(uid, text);
    for (const [uid, text] of complete) {
        const entry = next.entries[uid];
        entry.content = formatContent(entry.comment, text, orderFor(entry, packets)); markGenerated(entry);
    }
    const latest = bridge().snapshot().packets.find(item => item.id === packet.id);
    if (!latest || packetSignature(latest) !== packetSignature(packet)) throw new Error('The source packet changed during the request. Retry Update memory for the saved revision.');
    const saved = await saveBook(next, metadata, book);
    state().packets[packet.id] = packetSignature(packet);
    await saveState();
    return saved;
}
async function removePackets(book, ids, packets, metadata) {
    if (!ids.length) return book;
    const next = structuredClone(book), rebuild = [];
    for (const entry of ownedEntries(next, state().owner)) {
        const manual = detectManual(entry), meta = entryMeta(entry);
        const touched = ids.some(id => meta.contributions[id]);
        for (const id of ids) delete meta.contributions[id];
        if (!touched || manual) continue;
        if (!retainedFacts(entry).length) delete next.entries[entry.uid];
        else rebuild.push(entry);
    }
    const rebuilt = await fold(rebuild, metadata);
    for (const entry of rebuild) { entry.content = formatContent(entry.comment, rebuilt.get(entry.uid), orderFor(entry, packets)); markGenerated(entry); }
    const saved = await saveBook(next, metadata, book);
    for (const id of ids) delete state().packets[id];
    await saveState();
    return saved;
}
async function update(force = false) {
    if (busy || !settings().enabled) return;
    if (!bridge()?.snapshot || !bridge()?.request) { status('Update Summaryception to 5.5.4-local.19 or later, then reload ST.'); return; }
    if (bridge().isBusy()) {
        status('Summaryception is busy. Update memory after its request finishes.');
        if (!force) schedule();
        return;
    }
    const snapshot = bridge().snapshot(), metadata = snapshot.metadata;
    if (!snapshot.chatId) { status('Open a character chat first.'); return; }
    busy = true; controller = new AbortController(); renderBusy();
    try {
        let book = await getBook(true); const beforeNames = structuredClone(book); syncMainNames(book);
        book = await saveBook(book, metadata, beforeNames);
        const current = new Set(snapshot.packets.map(packet => packet.id));
        await history.prune(snapshot);
        const removed = Object.keys(state().packets).filter(id => !current.has(id));
        book = await removePackets(book, removed, snapshot.packets, metadata);
        const pending = snapshot.packets.filter(packet => !packet.stale && (force || state().packets[packet.id] !== packetSignature(packet) || history.pending(packet)));
        for (let i = 0; i < pending.length; i++) {
            unchanged(metadata); status(`Updating packet ${i + 1} / ${pending.length} · source ${sourceLabel(pending[i])}`);
            book = await applyPacket(pending[i], book, snapshot.packets, metadata);
        }
        unchanged(metadata);
        const stale = snapshot.packets.filter(packet => packet.stale).length;
        const waiting = ownedEntries(book, state().owner).filter(entry => entryMeta(entry).main && !entry.content?.trim()).length;
        const historyErrors = Object.values(state().history || {}).filter(item => item.error).length;
        status(stale ? `${stale} packet(s) have edited/deleted source messages. Regenerate them in Summaryception to refresh their WI.`
            : `Updated · ${ownedEntries(book, state().owner).length} records from ${Object.keys(state().packets).length} L0 packets.${waiting ? ` ${waiting} main profile(s) still have no played details; Update memory now can retry.` : ''}${historyErrors ? ` ${historyErrors} packet(s) need history markup; normal Summaryception memory is retained. Update memory now can retry.` : ''}`);
    } catch (error) {
        console.error('[World Memory]', error);
        status(controller?.signal.aborted ? 'Stopped. Already saved packets were kept.' : error.message);
        if (!controller?.signal.aborted) toastr.warning(error.message, 'World Memory');
    } finally { controller = null; busy = false; renderBusy(); await render(); }
}
function schedule() {
    clearTimeout(timer);
    if (!settings().enabled || !settings().auto) return;
    timer = setTimeout(() => {
        if (busy || bridge()?.isBusy()) { schedule(); return; }
        void update();
    }, 900);
}
function renderBusy() { $('#wm_update').prop('disabled', busy); $('#wm_stop').prop('disabled', !busy); }
function button(text, callback) {
    const node = document.createElement('button'); node.className = 'menu_button'; node.textContent = text;
    node.addEventListener('click', () => Promise.resolve(callback()).catch(error => status(error.message))); return node;
}
async function render() {
    const memory = state(), s = settings(), metadata = ctx().chatMetadata;
    const integration = globalThis.RussianWIForms?.getStatus?.();
    document.getElementById('wm_integration').textContent = `Summaryception: ${bridge()?.version || 'update required'} · Russian WI: ${integration ? integration.enabled ? integration.ready ? 'ready' : 'loading dictionary' : 'disabled' : 'not loaded (optional)'}`;
    document.getElementById('wm_book').textContent = memory?.book ? `Native book: ${memory.book}` : 'A separate chat-scoped book will be created on the first update.';
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
    for (const [id, key] of [['wm_enabled','enabled'],['wm_auto','auto'],['wm_main_constant','alwaysMain'],['wm_history','history'],['wm_hints','hints'],['wm_semantic','historySemantic']]) document.getElementById(id).checked = s[key];
    for (const [id, key] of [['wm_language','language'],['wm_target','targetTokens'],['wm_response_tokens','responseTokens'],['wm_detail_budget','detailTokens'],['wm_reference_budget','referenceTokens'],['wm_position','position'],['wm_depth','depth'],['wm_history_base','historyBaseTokens'],['wm_history_zoom','historyZoomTokens']]) document.getElementById(id).value = s[key];
    renderBusy();
}
async function applySettings() {
    history.changed();
    ctx().saveSettingsDebounced();
    if (!state()?.book || busy) return;
    const book = await getBook();
    for (const entry of ownedEntries(book, state().owner)) {
        if (detectManual(entry)) continue;
        Object.assign(entry, { position: settings().position, depth: settings().depth, constant: entryMeta(entry).main && settings().alwaysMain }); markGenerated(entry);
    }
    await saveBook(book, ctx().chatMetadata); await render();
}
function download(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function init() {
    nativeWI = await import('/scripts/world-info.js'); settings();
    history = installHistory({ ctx, settings, state, saveState, status, bridge });
    $('#extensions_settings2').append(await ctx().renderExtensionTemplateAsync('third-party/Extension-WorldMemory', 'settings', {}));
    for (const [id, key] of [['wm_enabled','enabled'],['wm_auto','auto'],['wm_main_constant','alwaysMain'],['wm_history','history'],['wm_hints','hints'],['wm_semantic','historySemantic']]) {
        document.getElementById(id).addEventListener('change', event => { settings()[key] = event.target.checked; void applySettings().catch(error => status(error.message)); });
    }
    for (const [id, key] of [['wm_language','language'],['wm_target','targetTokens'],['wm_response_tokens','responseTokens'],['wm_detail_budget','detailTokens'],['wm_reference_budget','referenceTokens'],['wm_position','position'],['wm_depth','depth'],['wm_history_base','historyBaseTokens'],['wm_history_zoom','historyZoomTokens']]) {
        document.getElementById(id).addEventListener('change', event => {
            settings()[key] = key === 'language' ? event.target.value : Math.max(['depth','detailTokens','position','responseTokens','historyZoomTokens'].includes(key) ? 0 : 1, Number(event.target.value) || 0);
            void applySettings().catch(error => status(error.message));
        });
    }
    document.getElementById('wm_main_names').addEventListener('change', async event => {
        if (!state()) return;
        state().mainNames = names(event.target.value); await saveState();
        status('Main character names saved. Update memory to create or refresh their profiles.');
    });
    $('#wm_update').on('click', () => { void update(true); });
    $('#wm_stop').on('click', () => { clearTimeout(timer); controller?.abort(); });
    $('#wm_open').on('click', () => { if (state()?.book) nativeWI.openWorldInfoEditor(state().book); else status('Update memory first to create the book.'); });
    $('#wm_export').on('click', async () => {
        if (!state()?.book) return status('There is no book to export yet.');
        download('world-memory-backup.json', { format: 'world-memory-v1', version: VERSION, state: state(), book: await getBook() });
    });
    $('#wm_import').on('click', () => document.getElementById('wm_import_file').click());
    $('#wm_import_file').on('change', async event => {
        try {
            if (busy || !state()) return;
            const file = event.target.files[0]; if (!file) return;
            const data = JSON.parse(await file.text());
            if (data.format !== 'world-memory-v1' || !data.book?.entries) throw new Error('Import a World Memory backup; native lorebooks can be imported in ST World Info.');
            const metadata = ctx().chatMetadata;
            await getBook(true);
            const book = structuredClone(data.book);
            const foreign = data.state?.chatId !== ctx().chatId;
            for (const entry of Object.values(book.entries)) if (entryMeta(entry)) {
                entryMeta(entry).owner = state().owner;
                if (foreign) { entryMeta(entry).manual = true; entryMeta(entry).contributions = {}; }
            }
            state().mainNames = data.state?.mainNames || [];
            // Imported source IDs belong to their original chat; current packets must be reconciled explicitly.
            state().packets = data.state?.chatId === ctx().chatId ? data.state.packets || {} : {};
            state().history = foreign ? {} : data.state?.history || {};
            history.changed();
            await saveBook(book, metadata); await render(); status('Backup imported. Review the profiles and source links before Update memory.');
        } catch (error) { status(error.message); toastr.warning(error.message, 'World Memory'); }
        finally { event.target.value = ''; }
    });
    const events = ctx().eventTypes || ctx().event_types;
    // Runs before RussianWI's normal listener, so it can expand the new ordinary keys too.
    ctx().eventSource.makeFirst(events.WORLDINFO_ENTRIES_LOADED, injectBook);
    ctx().eventSource.on('summaryception:memory-changed', event => { if (event.metadata === ctx().chatMetadata) { history.changed(); schedule(); } });
    ctx().eventSource.on(events.CHAT_CHANGED, () => {
        clearTimeout(timer); controller?.abort(); void render().catch(error => status(error.message));
    });
    for (const event of [events.MESSAGE_EDITED, events.MESSAGE_SWIPED, events.MESSAGE_DELETED].filter(Boolean)) ctx().eventSource.on(event, () => {
        if (state()?.book) status('Chat sources changed. Regenerate affected L0 summaries in Summaryception; World Memory follows their saved revisions.');
    });
    ctx().eventSource.on(events.WORLDINFO_UPDATED, () => { if (!busy) void render().catch(error => status(error.message)); });
    await render(); status('Ready. Update memory now builds existing packets; automatic updates follow newly saved packets.');
    globalThis.WorldMemory = Object.freeze({ version: VERSION, update: () => update(true), stop: () => controller?.abort(),
        prepareHistory: (...args) => history.prepare(...args), inspectHistory: () => history.inspect(),
        getStatus: () => ({ busy, book: state()?.book || null, enabled: settings().enabled }) });
}
init().catch(error => { console.error('[World Memory]', error); status(error.message); toastr.warning(error.message, 'World Memory'); });
