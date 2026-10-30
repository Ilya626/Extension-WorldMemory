// Sparse, source-bound NPC knowledge. No ST globals, model calls or WI mutations.
import { memoryTextRevision as revision } from './vendor/summaryception/memory-metadata.js';

export const KNOWLEDGE_BOUNDARIES_INSTRUCTION = `Optionally add "epistemic" to the SAME memory_metadata object:
[{"who":"exact supplied knowledge_characters ref, e.g. c1","about":"one precise proposition or secret","state":"unaware|heard|suspects|believes|knows","evidence":"short exact contiguous original quotation","src":["one new_sources handle"],"time":"current"}]
Return only important knowledge CHANGES directly supported by new_sources; [] is valid. Do not enumerate character/fact pairs. who MUST be an exact ref from knowledge_characters, never a name, guessed UID, new character or alias. Select it only when the sources establish that character's identity; matching names alone do not. An unresolved/new subject is omitted. Reuse the EXACT about text for the same proposition; never merge similar secrets. World truth, a speaker's claim, NPC belief and NPC knowledge differ. unaware requires explicit ignorance, not mere absence or not being told. heard means receipt, not acceptance or truth. knows needs explicit supported discovery/knowledge, not merely being told. Presence alone is not perception. Preserve who actually received a private/public disclosure. Copy evidence exactly with enough attribution and conditions. time:current asserts the state at this source's present; omit retrospective, hypothetical, future or unclear-time changes. Prior summaries/references are not new witnesses. Do not return IDs, offsets, revisions or a second narrative. Invalid/absent epistemic must not affect L0, search facts or WI.`;

const STATES = new Set(['unaware', 'heard', 'suspects', 'believes', 'knows']);
const key = character => JSON.stringify([character.world, character.uid]);
const identity = value => value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.world === 'string' && value.world.length > 0
    && (Number.isInteger(value.uid) && value.uid >= 0 || typeof value.uid === 'string' && value.uid.length > 0)
    && typeof value.name === 'string' && value.name.trim()
    ? { world: value.world, uid: value.uid, name: value.name,
        ...(value.revision !== undefined ? { revision: value.revision } : {}) } : null;

// The caller supplies an established source -> native character mapping. Never
// implement this callback by a name/alias/embedding match. Null means unresolved.
function resolve(resolver, who, sourceId, savedCharacter) {
    try { return typeof resolver === 'function' ? identity(resolver(who, sourceId, savedCharacter)) : null; }
    catch { return null; }
}

/** Parse only the optional object field; no prose or other metadata is rewritten.
 * sources: metadataSources(originals), resolver: (who, sourceId, savedCharacter?) -> unique
 * {world, uid, name, revision?} or null. revision identifies the identity binding,
 * not mutable WI content. A null result means keep previously saved rows.
 * Source quotation binding does NOT certify the model's semantic interpretation.
 */
export function readKnowledgeBoundaries(metadata, sources = [], { resolveCharacter, packetId = '' } = {}) {
    const result = { epistemic: null, warnings: [] };
    if (metadata?.epistemic === undefined) return result;
    if (!Array.isArray(metadata.epistemic)) {
        result.warnings.push('Optional epistemic was not an array; existing knowledge metadata was kept.');
        return result;
    }
    const rows = [];
    for (const input of metadata.epistemic) {
        if (!input || typeof input.who !== 'string' || !input.who.trim()
            || typeof input.about !== 'string' || !input.about.trim() || !STATES.has(input.state)
            || input.time !== 'current' || typeof input.evidence !== 'string' || !input.evidence.trim()
            || input.evidence.length > 1000 || input.about.length > 400
            || input.src !== undefined && (!Array.isArray(input.src) || input.src.length !== 1)) {
            result.warnings.push('An optional knowledge change had invalid fields and was ignored.'); continue;
        }
        // No quote normalization or guessed source. Repeated evidence is ambiguous,
        // even within the selected handle; request a longer exact quotation instead.
        const candidates = sources.filter(source => source && !source.hidden && source.sourceKind !== 'saved-summary'
            && typeof source.id === 'string' && typeof source.text === 'string'
            && (input.src === undefined || source.handle === input.src[0]))
            .flatMap(source => {
                const start = source.text.indexOf(input.evidence);
                return start >= 0 ? [{ source, start, unique: source.text.lastIndexOf(input.evidence) === start }] : [];
            });
        if (candidates.length !== 1 || !candidates[0].unique) {
            result.warnings.push('An optional knowledge quotation had no unique original source and was ignored.'); continue;
        }
        const { source, start } = candidates[0], character = resolve(resolveCharacter, input.who, source.id);
        if (!character) {
            result.warnings.push('An optional knowledge change had no established character identity and was ignored.'); continue;
        }
        const about = input.about.trim(), span = { sourceId: source.id, start, end: start + input.evidence.length,
            offsetUnit: 'utf16', endExclusive: true, sourceRevision: revision(source.text) };
        rows.push({ version: 1, id: `knowledge:${revision(JSON.stringify([packetId, key(character), about, input.state, span]))}`,
            who: input.who, character, about, state: input.state, time: 'current', evidence: input.evidence, sourceSpans: [span] });
    }
    // All-rejected output must never wipe good saved metadata on retry.
    if (rows.length || metadata.epistemic.length === 0) result.epistemic = rows;
    return result;
}

/** Non-destructive replay merge. Manual rows win over automatic rows addressing
 * the exact same character/proposition; unrelated or legacy rows remain stored.
 * A retry with [] or malformed output never removes previously accepted data.
 */
export function mergeKnowledgeBoundaries(previous, incoming) {
    const saved = Array.isArray(previous) ? previous : [], added = Array.isArray(incoming) ? incoming : [];
    const manualKeys = new Set(saved.filter(row => row?.manual && identity(row.character) && typeof row.about === 'string')
        .map(row => JSON.stringify([key(row.character), row.about])));
    const rows = saved.slice(), ids = new Set(rows.map(row => row?.id).filter(Boolean));
    for (const row of added) {
        if (!row || !identity(row.character) || ids.has(row.id)
            || manualKeys.has(JSON.stringify([key(row.character), row.about]))) continue;
        rows.push(row); ids.add(row.id);
    }
    return rows;
}

function currentRow(row, sources, resolveCharacter) {
    if (row?.version !== 1 || row.time !== 'current' || !STATES.has(row.state) || !identity(row.character)
        || typeof row.id !== 'string' || !row.id || typeof row.who !== 'string' || !row.who
        || typeof row.about !== 'string' || !row.about.trim() || typeof row.evidence !== 'string'
        || row.sourceSpans?.length !== 1) return null;
    const span = row.sourceSpans[0], source = sources.get(span.sourceId);
    if (!source || source.hidden || !Number.isInteger(source.index) || source.index < 0 || span.sourceRevision !== revision(source.text)
        || span.offsetUnit !== 'utf16' || span.endExclusive !== true || !Number.isInteger(span.start)
        || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > source.text.length
        || source.text.slice(span.start, span.end) !== row.evidence) return null;
    const character = resolve(resolveCharacter, row.who, source.id, row.character);
    if (!character || key(character) !== key(row.character)
        || (row.character.revision !== undefined && character.revision !== row.character.revision)) return null;
    return { ...row, character, order: source.index };
}

/** Derive guards only for explicitly active native identities. Pass current
 * archiveSnapshot packets, not saved rows alone. through is the inclusive RAW
 * source-message index. A packet crossing it is wholly ineligible. No top-K,
 * fuzzy topic matching, inferred ignorance or mutation of historical rows.
 */
export function currentKnowledgeBoundaries(packets = [], { activeCharacters = [], through = Infinity, resolveCharacter } = {}) {
    const active = new Set(activeCharacters.map(identity).filter(Boolean).map(key));
    const result = { text: '', rows: [], warnings: [] }, candidates = [];
    if (!active.size) return result;
    if (!(through === Infinity || Number.isInteger(through) && through >= 0)) return result;
    for (const packet of packets) {
        const metadata = packet?.memoryMetadata, stored = metadata?.epistemic;
        if (!Array.isArray(stored) || !stored.length) continue;
        const sources = new Map((packet.sources || []).map(source => [source.id, source]));
        const ids = packet.sourceMessageIds;
        if (packet.deleted || packet.stale || metadata.textRevision !== revision(packet.text || '')
            || metadata.sourceStatus === 'summary-only' || !Array.isArray(ids) || !ids.length
            || !ids.every(id => {
                const source = sources.get(id);
                return source && !source.hidden && typeof source.text === 'string'
                    && Number.isInteger(source.index) && source.index >= 0 && source.index <= through;
            })) {
            result.warnings.push('Knowledge from an unavailable, changed or non-prefix packet was withheld.'); continue;
        }
        for (const storedRow of stored) {
            if (!ids.includes(storedRow?.sourceSpans?.[0]?.sourceId)) continue;
            const row = currentRow(storedRow, sources, resolveCharacter);
            if (!row) { result.warnings.push('A knowledge source or character binding is no longer current.'); continue; }
            if (active.has(key(row.character))) candidates.push(row);
        }
    }
    // Only actual sparse changes create groups. Exact about text is deliberately
    // the topic identity; different wordings stay separate until author review.
    const topics = new Map();
    for (const row of candidates.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
        const topic = JSON.stringify([key(row.character), row.about]);
        if (!topics.has(topic)) topics.set(topic, []);
        topics.get(topic).push(row);
    }
    for (let rows of topics.values()) {
        if (rows.some(row => row.manual)) rows = rows.filter(row => row.manual);
        const current = new Map();
        for (const row of rows) {
            // A received claim cannot demote established knowledge or erase an
            // explicit belief. Same-message alternatives remain visible together;
            // quote position is not a reliable chronology of the described events.
            const slot = ['suspects', 'believes'].includes(row.state) ? 'attitude' : 'awareness';
            if (row.state === 'heard' && current.get('awareness')?.some(item => item.state === 'knows' && item.order < row.order)) continue;
            if ((row.state === 'unaware' || row.state === 'knows')
                && current.get('attitude')?.every(item => item.order < row.order)) current.delete('attitude');
            if (slot === 'attitude' && current.get('awareness')?.every(item => item.state === 'unaware' && item.order < row.order)) current.delete('awareness');
            const previous = current.get(slot) || [];
            current.set(slot, previous[0]?.order === row.order
                ? previous.some(item => item.state === row.state && item.evidence === row.evidence) ? previous : [...previous, row] : [row]);
        }
        result.rows.push(...[...current.values()].flat());
    }
    result.warnings = [...new Set(result.warnings)];
    if (!result.rows.length) return result;
    const lines = result.rows.map(row => `${row.character.name}: ${row.state} — ${row.about} [source message ${row.order}].`);
    result.text = ['GM context is not shared NPC knowledge. These states describe the named characters at their cited source messages; later original chat can establish discovery or supersede an older state. heard is receipt, not belief or truth; suspects/believes are unverified. Missing evidence is not proof of ignorance: avoid unsupported secret knowledge; allow questions, inference from available clues and later discovery. Preserve unresolved conflicts.', ...lines].join('\n');
    return result;
}
