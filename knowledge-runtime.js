// Native WI remains responsible for activation. Only scan-local content clones
// receive derived NPC guards; book text, keys and activation settings are untouched.
import { entryMeta } from './memory.js';
import { hash } from './history.js';
import { currentKnowledgeBoundaries } from './knowledge-boundaries.js';
import { buildAwarenessContext } from './awareness.js';

const LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];
const nativeKey = row => JSON.stringify([row.world, row.uid]);
const value = callback => typeof callback === 'function' ? callback() : callback;

/** Persist once in managed entry metadata; a recycled native UID gets a new
 * instance rather than inheriting the deleted person's knowledge bindings. */
export function ensureKnowledgeInstances(book, owner, makeId = () => globalThis.crypto.randomUUID()) {
    let changed = false;
    for (const entry of Object.values(book?.entries || {})) {
        const meta = entryMeta(entry);
        if (meta?.owner !== owner || meta.type !== 'character') continue;
        if (typeof meta.knowledgeInstance !== 'string' || !meta.knowledgeInstance) {
            meta.knowledgeInstance = makeId(); changed = true;
        }
    }
    return changed;
}

/** Native UID determines the ref, so removals/reordering never renumber anyone.
 * Only already managed character entries are eligible; author lore and this
 * request's prospective new WI subjects are never guessed into the catalogue.
 */
export function buildKnowledgeContext({ book, world, owner } = {}) {
    const knowledge_characters = [], byRef = new Map(), byNative = new Map();
    if (typeof world === 'string' && world && typeof owner === 'string' && owner) {
        const entries = Object.values(book?.entries || {}).filter(entry => entryMeta(entry)?.owner === owner
            && entryMeta(entry)?.type === 'character' && Number.isInteger(entry.uid) && entry.uid >= 0
            && typeof entry.comment === 'string' && entry.comment.trim()
            && typeof entryMeta(entry).knowledgeInstance === 'string' && entryMeta(entry).knowledgeInstance).sort((a, b) => a.uid - b.uid);
        const duplicates = new Set(entries.filter((entry, i) => i > 0 && entries[i - 1].uid === entry.uid).map(entry => entry.uid));
        for (const entry of entries) {
            if (duplicates.has(entry.uid)) continue;
            const character = { ref: `c${entry.uid}`, world, uid: entry.uid, name: entry.comment,
                revision: `native-character-v2:${hash(JSON.stringify([world, owner, entry.uid, entryMeta(entry).knowledgeInstance]))}` };
            knowledge_characters.push({ ref: character.ref, world, uid: entry.uid, name: character.name });
            byRef.set(character.ref, character); byNative.set(nativeKey(character), character);
        }
    }
    return { knowledge_characters,
        resolveCharacter(who, _sourceId, savedCharacter) {
            // Replay uses the saved native identity, never a new catalogue ordinal.
            // A changed book/owner/deleted UID invalidates the binding. Names and
            // mutable reference text do not serve as identity fingerprints.
            const found = savedCharacter ? byNative.get(nativeKey(savedCharacter)) : byRef.get(who);
            if (!found || savedCharacter && savedCharacter.revision !== found.revision) return null;
            return { world: found.world, uid: found.uid, name: found.name, revision: found.revision };
        } };
}

/** settings(): {enabled, knowledgeBoundaries?}; world()/owner() identify the
 * current managed book. snapshot() supplies current archiveSnapshot packets.
 * context() may be used for stage2 even with automatic WI generation switched off.
 */
export function createKnowledgeRuntime({ ctx, settings, snapshot, getBook, world, owner,
    through = () => Infinity, onUpdate = () => {} }) {
    let serial = 0, inspection = null, awarenessInspection = null, activatedProfiles = [], renderedAwareness = '';
    const originals = new WeakMap();
    const enabled = () => Boolean(settings()?.enabled && settings()?.knowledgeBoundaries);
    const notify = () => { try { onUpdate(); } catch (error) { console.warn('[WorldMemory] Knowledge status update failed.', error); } };
    const inspect = () => inspection || awarenessInspection ? structuredClone({ ...inspection, awareness: awarenessInspection }) : null;
    const clearAwareness = () => {
        awarenessInspection = null;
        activatedProfiles = []; renderedAwareness = '';
        ctx().setExtensionPrompt?.('world_memory_awareness', '', 1, 1, false, 0);
    };
    function invalidate() { serial++; inspection = null; clearAwareness(); notify(); }
    async function context({ before } = {}) {
        if (!enabled()) return buildKnowledgeContext();
        const currentWorld = value(world), currentOwner = value(owner), book = await getBook();
        if (!enabled() || currentWorld !== value(world) || currentOwner !== value(owner)) return buildKnowledgeContext();
        const catalogue = buildKnowledgeContext({ book, world: currentWorld, owner: currentOwner });
        if (Number.isInteger(before) && before > 0) {
            const prior = currentKnowledgeBoundaries(snapshot()?.packets || [], {
                activeCharacters: catalogue.knowledge_characters, through: before - 1,
                resolveCharacter: catalogue.resolveCharacter });
            const unique = new Map(prior.rows.map(row => {
                const topic = { who: `c${row.character.uid}`, about: row.about };
                return [JSON.stringify(topic), topic];
            }));
            catalogue.known_topics = [...unique.values()];
        }
        return catalogue;
    }
    async function onEntriesLoaded(payload) {
        clearAwareness();
        // A reused native event payload must also lose an old derived guard when
        // the feature is disabled, its book changes, or the next read fails.
        for (const list of LISTS) for (const [position, entry] of (payload?.[list] || []).entries()) {
            if (originals.has(entry)) payload[list][position] = originals.get(entry);
        }
        if (!enabled()) { invalidate(); return; }
        const run = ++serial, metadata = ctx().chatMetadata, chat = ctx().chat;
        const currentWorld = value(world), currentOwner = value(owner);
        try {
            const catalogue = await context();
            if (run !== serial || ctx().chatMetadata !== metadata || ctx().chat !== chat
                || currentWorld !== value(world) || currentOwner !== value(owner) || !enabled()) return;
            const known = new Map(catalogue.knowledge_characters.map(row => [nativeKey(row), row]));
            const captured = snapshot(), packets = captured?.packets || [], boundary = value(through);
            const changes = [], selected = new Map(), warnings = new Set();
            for (const list of LISTS) for (const [position, scanEntry] of (payload?.[list] || []).entries()) {
                // Repeated events over the same array reuse its original content.
                const entry = originals.get(scanEntry) || scanEntry;
                if (!entry || entry.disable || typeof entry.content !== 'string' || !known.has(nativeKey(entry))) continue;
                const character = known.get(nativeKey(entry));
                const guard = currentKnowledgeBoundaries(packets, { activeCharacters: [character], through: boundary,
                    resolveCharacter: catalogue.resolveCharacter });
                guard.warnings.forEach(warning => warnings.add(warning));
                if (!guard.text) continue;
                const content = `${entry.content}\n\n[Current character knowledge]\n${guard.text}`;
                const clone = { ...entry, content };
                originals.set(clone, entry); changes.push([payload[list], position, clone]);
                selected.set(nativeKey(character), { world: character.world, uid: character.uid, name: character.name,
                    rows: guard.rows.length });
            }
            // All work after the read is local/synchronous. Replace entries only;
            // native ST retains the event-array references for its own scan.
            for (const [list, position, clone] of changes) list[position] = clone;
            inspection = { status: 'ready', transformed: changes.length, selected: [...selected.values()], warnings: [...warnings] };
        } catch (error) {
            if (run === serial) inspection = { status: 'unavailable', transformed: 0, selected: [], warnings: [error.message] };
        }
        notify();
    }
    async function onActivated(entries) {
        clearAwareness();
        if (!enabled()) return;
        // Final presence checking below is a Chat Completion hook. Other API
        // builders keep the stored journal but do not receive this addition.
        if (ctx().mainApi !== 'openai') {
            awarenessInspection = { status: 'unsupported-api', selected: [], emittedRows: 0,
                delivered: false, warnings: ['Information-event context currently requires Chat Completion.'] };
            notify(); return;
        }
        const run = serial, metadata = ctx().chatMetadata, chat = ctx().chat;
        const currentWorld = value(world), currentOwner = value(owner);
        try {
            const [regex, wi, native] = await Promise.all([import('/scripts/extensions/regex/engine.js'),
                import('/scripts/world-info.js'), import('/script.js')]);
            const catalogue = await context();
            if (run !== serial || ctx().chatMetadata !== metadata || ctx().chat !== chat
                || currentWorld !== value(world) || currentOwner !== value(owner) || !enabled()
                || ctx().mainApi !== 'openai') return;
            // This event is emitted after native group/probability/token selection.
            // Loaded candidates never establish the current focus.
            const profiles = (entries || []).filter(entry => !entry.disable).map(entry => ({ entry,
                text: regex.getRegexedString(entry.content, regex.regex_placement.WORLD_INFO, {
                    depth: entry.position === wi.world_info_position.atDepth ? (entry.depth ?? wi.DEFAULT_DEPTH) : null,
                    isMarkdown: false, isPrompt: true }) })).filter(profile => profile.text);
            const selected = new Set(profiles.map(profile => nativeKey(profile.entry)));
            const activeCharacters = catalogue.knowledge_characters.filter(row => selected.has(nativeKey(row)));
            const result = buildAwarenessContext(snapshot()?.packets || [], { activeCharacters,
                through: value(through), resolveCharacter: catalogue.resolveCharacter,
                mode: settings()?.awarenessGraph ? 'C' : 'B' });
            // Keep complete evidence rows. Native prompt assembly subsequently counts
            // this separate non-scannable injection with other extension prompts.
            // A capped graph cannot retain its section labels after rows are omitted;
            // use the safe direct-only build instead of relabelling related evidence.
            const capped = result.text.length > 12000;
            const direct = capped ? buildAwarenessContext(snapshot()?.packets || [], { activeCharacters,
                through: value(through), resolveCharacter: catalogue.resolveCharacter, mode: 'B' }) : result;
            const directLines = direct.text.split('\n');
            const kept = []; let chars = directLines.slice(0, 2).join('\n').length;
            for (const line of directLines.slice(2).reverse()) {
                if (chars + line.length + 1 > 12000) continue;
                kept.unshift(line); chars += line.length + 1;
            }
            const text = capped ? (kept.length ? [...directLines.slice(0, 2), ...kept].join('\n') : '') : result.text;
            ctx().setExtensionPrompt?.('world_memory_awareness', text, 1, 1, false, 0);
            renderedAwareness = native.substituteParams(text);
            activatedProfiles = activeCharacters.map(character => ({ character,
                text: native.substituteParams(profiles.find(profile => nativeKey(profile.entry) === nativeKey(character)).text) }));
            awarenessInspection = { status: 'ready', activation: 'WORLD_INFO_ACTIVATED', selected: activeCharacters,
                rows: result.rows.length, relatedRows: capped ? 0 : result.relatedRows.length,
                emittedRows: capped ? kept.length : result.rows.length + result.relatedRows.length,
                capped, chars: text.length, warnings: result.warnings };
        } catch (error) {
            awarenessInspection = { status: 'unavailable', selected: [], warnings: [error.message] };
        }
        notify();
    }
    function onPromptReady(payload) {
        if (!awarenessInspection || payload?.dryRun || !Array.isArray(payload?.chat)) return;
        const texts = payload.chat.flatMap(message => typeof message.content === 'string' ? [message.content]
            : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text) : []);
        const ordinary = texts.map(text => renderedAwareness ? text.replace(renderedAwareness, '') : text).join('\n');
        const present = activatedProfiles.filter(profile => ordinary.includes(profile.text));
        if (present.length !== activatedProfiles.length && renderedAwareness) {
            // Final assembly may trim a native profile. Withhold this optional
            // addition rather than retain a focus unsupported by the actual wire.
            for (const message of payload.chat) {
                if (typeof message.content === 'string') message.content = message.content.replace(renderedAwareness, '');
                else if (Array.isArray(message.content)) for (const part of message.content) {
                    if (part.type === 'text') part.text = part.text.replace(renderedAwareness, '');
                }
            }
            awarenessInspection.status = 'withheld'; awarenessInspection.emittedRows = 0;
            awarenessInspection.warnings.push('A selected native profile was absent after final prompt assembly; optional awareness was withheld.');
        }
        awarenessInspection.selected = present.map(profile => profile.character);
        awarenessInspection.delivered = present.length === activatedProfiles.length
            && Boolean(renderedAwareness && texts.some(text => text.includes(renderedAwareness)));
        if (!awarenessInspection.delivered) {
            awarenessInspection.emittedRows = 0;
            if (renderedAwareness && awarenessInspection.status !== 'withheld') {
                awarenessInspection.status = 'withheld';
                awarenessInspection.warnings.push('Optional information-event context was absent after final prompt assembly.');
            }
        }
        awarenessInspection.finalPromptChecked = true;
        awarenessInspection.profileCandidates = activatedProfiles.length;
        awarenessInspection.actualProfiles = present.length;
        notify();
    }
    const current = ctx(), events = current.eventTypes || current.event_types || {}, listeners = [];
    const listen = (event, handler) => { if (event && current.eventSource?.on) {
        current.eventSource.on(event, handler); listeners.push([event, handler]);
    } };
    listen(events.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    listen(events.WORLD_INFO_ACTIVATED, onActivated);
    listen(events.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    listen(events.GENERATION_AFTER_COMMANDS, clearAwareness);
    for (const event of [events.CHAT_CHANGED, events.MESSAGE_EDITED, events.MESSAGE_UPDATED, events.MESSAGE_SWIPED,
        events.MESSAGE_DELETED, events.WORLDINFO_UPDATED, events.GENERATION_STOPPED].filter(Boolean)) listen(event, invalidate);
    return { context, onEntriesLoaded, onActivated, inspect, invalidate,
        dispose() { invalidate(); for (const [event, handler] of listeners) current.eventSource.removeListener(event, handler); } };
}
