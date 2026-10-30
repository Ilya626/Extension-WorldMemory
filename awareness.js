// Experimental local information-event journal. No runtime hooks or model calls.
import { memoryTextRevision as revision } from './vendor/summaryception/memory-metadata.js';

export const AWARENESS_INSTRUCTION = `Optionally return "awareness" in the metadata object:
[{"kind":"observed|reported","about":"one precise information item","actors":["exact supplied knowledge_characters ref, e.g. c1"],"from":"optional exact supplied speaker ref","evidence":"short exact contiguous original quotation","src":["one new_sources handle"]}]
Record only source-supported events of actually seeing/hearing information. observed means direct perception; reported means receiving a statement, not its truth or acceptance. actors are the established recipients/observers, never everyone present or everyone acquainted. from is the established speaker of a report; omit if unresolved. Use only supplied managed character refs whose identity the source establishes; omit unresolved recipients. Presence alone is not perception. Retain attribution, privacy, conditions and uncertainty in about and in enough exact evidence. Copy evidence exactly from one original, never from a prior summary/reference. Use the EXACT same about for the same information item, without merging merely similar topics. Omit hypothetical/future/unclear-time events, knowledge labels and claims of ignorance. Missing actors do not mean those actors are unaware. [] is valid. Do not return IDs, offsets, revisions or another narrative. This optional field must not change L0 or L-double-prime.`;

const KINDS = new Set(['observed', 'reported']);
const ref = value => typeof value === 'string' && /^c\d+$/.test(value);
const actorKey = actor => JSON.stringify([actor.world, actor.uid]);
const identity = actor => actor && typeof actor.world === 'string' && actor.world
    && Number.isInteger(actor.uid) && actor.uid >= 0 && typeof actor.name === 'string' && actor.name.trim()
    && typeof actor.revision === 'string' && actor.revision ? actor : null;
const activeIdentity = actor => actor && typeof actor.world === 'string' && actor.world
    && Number.isInteger(actor.uid) && actor.uid >= 0;
const eventKey = row => JSON.stringify([row.kind, row.about,
    row.actors.map(actor => actorKey(actor.character)).sort(),
    row.from ? actorKey(row.from.character) : null, row.sourceSpans]);
const evidenceKey = row => JSON.stringify(row.sourceSpans);
const chronological = (a, b) => a.order - b.order
    || a.sourceSpans[0].start - b.sourceSpans[0].start || a.id.localeCompare(b.id);
function resolve(resolver, who, sourceId, saved) {
    try {
        const actor = typeof resolver === 'function' ? identity(resolver(who, sourceId, saved)) : null;
        return actor ? { world: actor.world, uid: actor.uid, name: actor.name, revision: actor.revision } : null;
    } catch { return null; }
}

/** sources are original source records with request-local handles. Supply only
 * the existing buildKnowledgeContext().resolveCharacter, never name matching.
 * Exact quotes establish provenance, not correctness of the event interpretation.
 */
export function readAwarenessEvents(metadata, sources = [], { resolveCharacter, packetId = '' } = {}) {
    const result = { awareness: null, warnings: [] };
    if (metadata?.awareness === undefined) return result;
    if (!Array.isArray(metadata.awareness)) {
        result.warnings.push('Optional awareness was not an array; saved events were kept.'); return result;
    }
    const rows = [];
    for (const input of metadata.awareness) {
        if (!input || !KINDS.has(input.kind) || typeof input.about !== 'string' || !input.about.trim()
            || input.about.length > 400 || !Array.isArray(input.actors) || !input.actors.length
            || !input.actors.every(ref) || new Set(input.actors).size !== input.actors.length
            || input.from !== undefined && (!ref(input.from) || input.kind !== 'reported')
            || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 1000
            || !Array.isArray(input.src) || input.src.length !== 1 || typeof input.src[0] !== 'string') {
            result.warnings.push('An awareness event had invalid fields and was ignored.'); continue;
        }
        const candidates = sources.filter(source => source && !source.hidden && source.sourceKind !== 'saved-summary'
            && source.handle === input.src[0] && typeof source.id === 'string' && source.id
            && typeof source.text === 'string').map(source => ({ source, start: source.text.indexOf(input.evidence) }))
            .filter(({ start }) => start >= 0);
        if (candidates.length !== 1 || candidates[0].source.text.lastIndexOf(input.evidence) !== candidates[0].start) {
            result.warnings.push('An awareness quotation had no unique original source and was ignored.'); continue;
        }
        const { source, start } = candidates[0];
        const actors = input.actors.map(who => ({ who, character: resolve(resolveCharacter, who, source.id) }));
        const from = input.from === undefined ? undefined : { who: input.from, character: resolve(resolveCharacter, input.from, source.id) };
        if (actors.some(actor => !actor.character) || from && !from.character) {
            result.warnings.push('An awareness event had no established managed identity and was ignored.'); continue;
        }
        const sourceSpans = [{ sourceId: source.id, start, end: start + input.evidence.length,
            offsetUnit: 'utf16', endExclusive: true, sourceRevision: revision(source.text) }];
        const about = input.about.trim();
        const row = { version: 1, kind: input.kind, about, actors, ...(from ? { from } : {}),
            evidence: input.evidence, sourceSpans };
        rows.push({ ...row, id: `awareness:${revision(JSON.stringify([packetId, row]))}` });
    }
    if (rows.length || metadata.awareness.length === 0) result.awareness = rows;
    return result;
}

/** Append only; empty/failed retries cannot erase events or author corrections. */
export function mergeAwarenessEvents(previous, incoming) {
    const rows = Array.isArray(previous) ? previous.slice() : [];
    const ids = new Set(rows.map(row => row?.id));
    const manual = new Set(rows.filter(row => row?.manual && Array.isArray(row.actors)
        && row.actors.every(actor => identity(actor?.character))).map(eventKey));
    for (const row of Array.isArray(incoming) ? incoming : []) {
        if (!row || !Array.isArray(row.actors) || !row.actors.length
            || !row.actors.every(actor => identity(actor?.character)) || typeof row.id !== 'string'
            || ids.has(row.id) || manual.has(eventKey(row))) continue;
        rows.push(row); ids.add(row.id);
    }
    return rows;
}

function currentRow(row, sources, resolveCharacter) {
    if (row?.version !== 1 || !KINDS.has(row.kind) || typeof row.id !== 'string' || !row.id
        || typeof row.about !== 'string' || !row.about.trim() || typeof row.evidence !== 'string' || !row.evidence
        || !Array.isArray(row.actors) || !row.actors.length || row.sourceSpans?.length !== 1
        || row.from !== undefined && row.kind !== 'reported') return null;
    const span = row.sourceSpans[0], source = sources.get(span?.sourceId);
    if (!source || source.hidden || source.sourceKind === 'saved-summary' || typeof source.text !== 'string'
        || !Number.isInteger(source.index) || span.sourceRevision !== revision(source.text)
        || span.offsetUnit !== 'utf16' || span.endExclusive !== true || !Number.isInteger(span.start)
        || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > source.text.length
        || source.text.slice(span.start, span.end) !== row.evidence) return null;
    const replay = actor => {
        if (!ref(actor?.who) || !identity(actor.character)) return null;
        const character = resolve(resolveCharacter, actor.who, source.id, actor.character);
        return character && actorKey(character) === actorKey(actor.character)
            && character.revision === actor.character.revision ? { who: actor.who, character } : null;
    };
    const actors = row.actors.map(replay), from = row.from === undefined ? undefined : replay(row.from);
    if (actors.some(actor => !actor) || new Set(actors.map(actor => actorKey(actor.character))).size !== actors.length
        || row.from !== undefined && !from) return null;
    return { ...row, actors, ...(from ? { from } : {}), order: source.index };
}

/** Replay only current original-backed packets entirely inside the raw prefix.
 * Signed source indices support the retained prehistory (-46..-1) before played
 * chat (0..cutoff). Nothing is inferred for actors absent from the journal.
 */
export function currentAwarenessEvents(packets = [], { through = Infinity, resolveCharacter } = {}) {
    const result = { rows: [], warnings: [] };
    if (!(through === Infinity || Number.isInteger(through))) return result;
    const idsSeen = new Set();
    for (const packet of packets) {
        const metadata = packet?.memoryMetadata, stored = metadata?.awareness;
        if (!Array.isArray(stored) || !stored.length) continue;
        const sources = new Map((packet.sources || []).map(source => [source.id, source]));
        const ids = packet.sourceMessageIds;
        if (packet.deleted || packet.stale || metadata.textRevision !== revision(packet.text || '')
            || metadata.sourceStatus === 'summary-only' || !Array.isArray(ids) || !ids.length
            || !ids.every(id => {
                const source = sources.get(id);
                return source && !source.hidden && source.sourceKind !== 'saved-summary' && typeof source.text === 'string'
                    && Number.isInteger(source.index) && source.index <= through;
            })) {
            result.warnings.push('Awareness from an unavailable, changed or non-prefix packet was withheld.'); continue;
        }
        for (const storedRow of stored) {
            if (!ids.includes(storedRow?.sourceSpans?.[0]?.sourceId)) continue;
            const row = currentRow(storedRow, sources, resolveCharacter);
            if (!row) { result.warnings.push('An awareness source or managed identity binding is no longer current.'); continue; }
            if (!idsSeen.has(row.id)) { result.rows.push(row); idsSeen.add(row.id); }
        }
    }
    const manual = new Set(result.rows.filter(row => row.manual).map(eventKey));
    result.rows = result.rows.filter(row => row.manual || !manual.has(eventKey(row)))
        .sort(chronological);
    result.warnings = [...new Set(result.warnings)];
    return result;
}

/** Derived, disposable Maps over exactly the replayed rows, never a second truth
 * store. Edges are actor <-> event <-> original source; reports distinguish the
 * speaker from recipients. byAbout is exact-text lookup, not semantic matching.
 */
export function buildAwarenessGraph(rows = []) {
    const events = new Map(), actors = new Map(), sources = new Map(), byAbout = new Map();
    const connect = (map, key, id) => {
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(id);
    };
    for (const row of rows) {
        events.set(row.id, row);
        for (const actor of [...row.actors, ...(row.from ? [row.from] : [])]) connect(actors, actorKey(actor.character), row.id);
        connect(sources, row.sourceSpans[0].sourceId, row.id);
        connect(byAbout, row.about, row.id);
    }
    return { events, actors, sources, byAbout };
}

const HEADER = 'GM-only information-event evidence. The GM retains all secrets and the complete story spine. These are source-backed observations/receipts, not a model of world truth or current knowledge. reported means receipt of a statement, not belief or truth; observed preserves the cited perception and its limits. Absence is not proof of ignorance. Later original chat can add discovery. Do not propagate information through acquaintance or shared graph links. Exact quotation validates provenance, not interpretation.';
const line = row => JSON.stringify({ kind: row.kind, about: row.about,
    actors: row.actors.map(actor => ({ ref: actor.who, name: actor.character.name })),
    ...(row.from ? { from: { ref: row.from.who, name: row.from.character.name } } : {}),
    evidence: row.evidence, source: row.sourceSpans[0].sourceId, index: row.order });
const bound = (value, fallback, max) => Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;

/** B: direct participation by explicitly active managed actors. C: the same B
 * rows plus one bounded hop to other events sharing an exact topic or original
 * source. Shared actors alone are NOT an expansion rule. Links expose possible
 * information channels to the GM; they never create recipient/knowledge edges.
 * Without additional source evidence, C returns byte-identical B text.
 */
export function buildAwarenessContext(packets = [], { activeCharacters = [], through = Infinity,
    resolveCharacter, mode = 'B', maxRelatedRows = 8, maxRelatedChars = 6000 } = {}) {
    if (mode !== 'B' && mode !== 'C') throw new TypeError('Awareness mode must be B or C.');
    const current = currentAwarenessEvents(packets, { through, resolveCharacter });
    const active = new Set(activeCharacters.filter(activeIdentity).map(actorKey));
    const rows = current.rows.filter(row => row.actors.some(actor => active.has(actorKey(actor.character)))
        || row.from && active.has(actorKey(row.from.character)));
    const relatedRows = [], relatedLinks = [], graph = mode === 'C' ? buildAwarenessGraph(current.rows) : null;
    if (graph && rows.length) {
        const candidates = new Map(), selected = new Set(rows.map(row => row.id));
        for (const row of rows) {
            for (const [via, key, index] of [['about', row.about, graph.byAbout],
                ['source', row.sourceSpans[0].sourceId, graph.sources]]) {
                for (const id of index.get(key) || []) if (!selected.has(id)) {
                    if (!candidates.has(id)) candidates.set(id, []);
                    candidates.get(id).push({ seedEventId: row.id, via });
                }
            }
        }
        const evidence = new Set(rows.map(evidenceKey));
        const countLimit = bound(maxRelatedRows, 8, 64), charLimit = bound(maxRelatedChars, 6000, 16000);
        let chars = 0;
        const ranked = [...candidates.keys()].map(id => graph.events.get(id))
            .sort((a, b) => -chronological(a, b));
        for (const row of ranked) {
            if (relatedRows.length >= countLimit) break;
            const size = line(row).length + 1;
            if (evidence.has(evidenceKey(row)) || chars + size > charLimit) continue;
            relatedRows.push(row); relatedLinks.push({ eventId: row.id, links: candidates.get(row.id) });
            evidence.add(evidenceKey(row)); chars += size;
        }
    }
    // Select recent related evidence first, then show it in source-text order.
    relatedRows.sort(chronological);
    const direct = rows.length ? [HEADER, '[Direct information events]', ...rows.map(line)].join('\n') : '';
    const text = relatedRows.length ? [direct,
        '[Related original evidence: links do not establish that active actors received this information]',
        ...relatedRows.map(line)].join('\n') : direct;
    return { text, rows, relatedRows, relatedLinks, warnings: current.warnings,
        graphStatus: relatedRows.length ? 'expanded' : 'identical',
        graph: graph ? { events: graph.events.size, actors: graph.actors.size, sources: graph.sources.size } : null };
}
