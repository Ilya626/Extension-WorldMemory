// Native WI remains responsible for activation. Only scan-local content clones
// receive derived NPC guards; book text, keys and activation settings are untouched.
import { entryMeta } from './memory.js';
import { hash } from './history.js';
import { currentKnowledgeBoundaries } from './knowledge-boundaries.js';

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
    let serial = 0, inspection = null;
    const originals = new WeakMap();
    const enabled = () => Boolean(settings()?.enabled && settings()?.knowledgeBoundaries);
    const notify = () => { try { onUpdate(); } catch (error) { console.warn('[WorldMemory] Knowledge status update failed.', error); } };
    const inspect = () => inspection ? structuredClone(inspection) : null;
    function invalidate() { serial++; inspection = null; notify(); }
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
    const current = ctx(), events = current.eventTypes || current.event_types || {}, listeners = [];
    const listen = (event, handler) => { if (event && current.eventSource?.on) {
        current.eventSource.on(event, handler); listeners.push([event, handler]);
    } };
    listen(events.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    for (const event of [events.CHAT_CHANGED, events.MESSAGE_EDITED, events.MESSAGE_UPDATED, events.MESSAGE_SWIPED,
        events.MESSAGE_DELETED, events.WORLDINFO_UPDATED, events.GENERATION_STOPPED].filter(Boolean)) listen(event, invalidate);
    return { context, onEntriesLoaded, inspect, invalidate,
        dispose() { invalidate(); for (const [event, handler] of listeners) current.eventSource.removeListener(event, handler); } };
}
