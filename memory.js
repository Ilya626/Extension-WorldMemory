import { parseModelJson } from './model-json.js';
export const VERSION = '0.5.24';
export const OWNER = 'worldMemory';
export const TYPES = ['character', 'place', 'object', 'organization', 'lore'];
export const normalize = text => String(text || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
export const signature = value => JSON.stringify(value);
export const entryMeta = entry => entry?.extensions?.[OWNER];
export const fingerprint = entry => signature([entry.comment, entry.key, entry.content, entry.constant, entry.disable]);
export const packetSignature = packet => signature([packet.text, packet.sourceMessageIds, packet.sources.map(source => [source.id, source.text])]);
export const sourceLabel = packet => packet.sources.length ? packet.sources.map(source => source.index).join(', ') : 'legacy summary';

export function parseResult(text) {
    let result;
    try { result = parseModelJson(text); }
    catch (error) { throw new Error(`WI response: ${error.message}. Existing WI was kept; download WI diagnostics beside preparation.`); }
    if (!result?.updates && result?.wi?.updates) result = result.wi;
    if (!Array.isArray(result.updates)) throw new Error('The model response has no updates array. Existing WI was kept.');
    return result.updates.map(item => {
        if (!item || typeof item.name !== 'string' || typeof item.facts !== 'string' || typeof item.content !== 'string') {
            throw new Error('A WI update is missing its name, facts or content. Existing WI was kept.');
        }
        const name = item.name.trim();
        if (!name) throw new Error('A WI update has an empty name. Existing WI was kept.');
        return { uid: Number.isInteger(item.uid) ? item.uid : null, name,
            type: TYPES.includes(item.type) ? item.type : 'lore', main: Boolean(item.main),
            keys: [...new Set((Array.isArray(item.keys) ? item.keys : [name]).filter(key => typeof key === 'string' && key.trim()).map(key => key.trim()))],
            facts: item.facts.trim(), content: item.content.trim() };
    });
}

/** The saved optional tail is applied locally; malformed WI never rejects L0. */
export function readSummaryWI(value) {
    if (!value || !Array.isArray(value.updates)) throw new Error('No valid saved WI updates. Refine the L0 or use Update legacy WI.');
    const uids = new Set();
    for (const item of value.updates) {
        if (!item || (item.uid !== null && (!Number.isInteger(item.uid) || item.uid < 0))) throw new Error('Saved WI has an invalid native UID. Refine the L0 or use Update legacy WI.');
        if (item.uid !== null && uids.has(item.uid)) throw new Error('Saved WI repeats a native UID. Refine the L0 or use Update legacy WI.');
        if (item.uid !== null) uids.add(item.uid);
        if (!TYPES.includes(item.type) || typeof item.main !== 'boolean' || !Array.isArray(item.keys) || item.keys.some(key => typeof key !== 'string' || !key.trim())) {
            throw new Error('Saved WI has invalid reference fields. Refine the L0 or use Update legacy WI.');
        }
    }
    return parseResult(JSON.stringify(value));
}

/** Compact preconditions for the retained evidence actually supplied to a model. */
export function evidenceRevision(entry, omitPacket = null) {
    return compactRevision([entry.comment, entry.key, entryMeta(entry)?.type, entryMeta(entry)?.main,
        detectManual(entry), retainedFacts(entry, omitPacket)]);
}
export function compactRevision(value) {
    const text = signature(value);
    let a = 2166136261, b = 5381;
    for (const char of text) { const n = char.codePointAt(0); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

/** Source removal has a deterministic, request-free fallback. No deleted facts survive. */
export function retainedContent(entry) {
    const seen = new Set();
    const facts = retainedFacts(entry).flatMap(item => {
        const text = item.facts?.trim();
        if (!text || seen.has(text)) return [];
        seen.add(text); return [text];
    });
    return (facts.length > 1 ? 'Retained reference evidence, earlier to later. Later supported changes supersede earlier state; claims and plans remain attributed.\n' : '') + facts.join('\n\n');
}

export function ownedEntries(book, owner) {
    return Object.values(book?.entries || {}).filter(entry => entryMeta(entry)?.owner === owner);
}

export function retainedFacts(entry, omitPacket = null) {
    return Object.entries(entryMeta(entry)?.contributions || {}).filter(([id]) => id !== omitPacket)
        .map(([id, value]) => ({ packet: id, order: value.order ?? Number.MAX_SAFE_INTEGER, facts: value.facts }))
        .sort((a, b) => a.order - b.order);
}

export function detectManual(entry) {
    const meta = entryMeta(entry);
    if (meta && meta.lastGenerated && meta.lastGenerated !== fingerprint(entry)) meta.manual = true;
    return Boolean(meta?.manual);
}

export function markGenerated(entry) {
    entryMeta(entry).lastGenerated = fingerprint(entry);
}

export function formatContent(name, text, packetOrder = null) {
    return `${name}\n${packetOrder === null ? '' : `[Played memory through source message ${packetOrder}; later chat may supersede this state.]\n`}${text}`;
}

export const SYSTEM = `You maintain concise entity profiles and reference World Info for a roleplay chat.
Return JSON only. You are not the RP narrator. Supplied original messages are primary evidence. The saved L0 is a draft navigation aid, not independent proof; use it as the earliest available account only when originals are explicitly unavailable. Existing record facts are separately sourced prior evidence. Never import author secrets, predictions or unsupported player/NPC actions.
Preserve the narrative summary's role: World Info is a reusable reference about an identifiable person, place, object or group, not a second chronological scene report. Keep uncertainty and speaker attribution. An attempt, permission, promise, photograph on undeveloped film and verified result are different things.
ENTITY COVERAGE IS REQUIRED: inspect the complete source packet, not just its last scene. Maintain a separate character reference for each identifiable named person with meaningful actions, dialogue, distinguishing traits, relationships or lasting changes in this packet, including the player's actual character when known. A secondary character still deserves a reference; main:false does not mean omit. Also maintain references for identifiable places, organizations, objects and world rules when the sources establish reusable information about them. A passing mention without such information needs no record. Do not treat a GM/scenario card title as a person. Explicit main-character names are always tracked, but absent evidence must not be invented.
Keep names and observed aliases in their original source spelling and script, including in keys; do not replace Russian names with English translations. Use the requested WI language for reference prose, independently of the L0 language. Combine aliases only when the supplied evidence or reference context establishes that they denote the same subject; preserve the observed aliases as keys. Do not create separate entries for an established name and its established alias.
Use the supplied native UID for existing records, including empty main-profile placeholders. Return at most one update per UID. A matching word, surname or inflection does not establish identity. Never combine different people. uid:null means a genuinely new subject, not a rename of a listed record. Return only records receiving evidence from this packet; no change is valid.
Before writing updates, reconcile subjects against the entire existing_index, including inactive records and records without retained_evidence. Missing prior details do not make an existing subject new: use its UID and give only the current packet's facts; the application preserves its other contributions. Resolve identity from the supplied sources and reference context, never from name equality, overlapping keys or inflection alone. For genuinely different namesakes, use source-supported distinguishing names or roles without inventing distinctions. Emit at most one uid:null update per genuinely new subject, combining all of that subject's current-packet evidence into its facts and content.
For each record write facts as self-contained subject reference clauses supported ONLY by the current packet, one clause per line. Name the subject and preserve the exact agency, object, modality and conditions. These are derived contributions, not quotations; search excerpts are separate. Do not copy prior evidence into this packet's facts. Build complete content by reusing these clauses and the supplied retained clauses without rephrasing their predicates; remove only duplicates or explicitly superseded states. Organize by what is useful to know about the subject, not by episode order. Later supported changes replace earlier state, not earlier history. Correct uncertainty rather than invent a resolution.
The final content must keep attribution and all conditions that make its claims true: required place, trigger, time, prerequisite and linked risk. A character's diagnosis remains that character's inference, not established knowledge. Every new reference claim in content must occur in that subject's current facts. For a new record without retained clauses, content uses the same clauses as facts.
Prefer subject names and observed aliases as entry keys. Do not generate inflection regexes, broad keys such as documents/people/everything, invented name forms, or ST instructions. Russian WI Forms will handle dictionary inflections.
Schema: {"updates":[{"uid":0 or null,"name":"specific subject","type":"character|place|object|organization|lore","main":true or false,"keys":["ordinary keyword"],"facts":"current-source subject reference clauses, one per line","content":"complete merged reference"}]}.`;

export const SUMMARY_WI_SYSTEM = SYSTEM
    .replace('Return JSON only.', 'Return only the requested memory_metadata block. When original sources and world_memory_context are supplied, wi is a REQUIRED part of that block, alongside lprime and search facts; do not repeat L0 prose or produce a separate WI answer. Put wi first in the JSON object and reserve enough response space for all supported entity references before selecting the search excerpts.')
    .replace('Schema:', 'Schema of memory_metadata.wi:')
    + `\nThe supplied world_memory_context is prior reference evidence, not additional played events. For this packet's new WI facts, use its supplied source messages; saved_summary is a draft, not independent proof. Never copy retained facts into this packet's facts. Do not rewrite manual records. All existing subjects use their supplied native UID, including empty main profiles. For an existing UID absent from retained_evidence, give its current-packet facts; the application preserves prior contributions locally. Merge content only from retained_evidence and this packet, using source order even when refining an earlier L0. A reference is not a scene diary. Preserve who knows what, thoughts versus speech, promises versus outcomes, identity and relationship conditions. Omit an uncertain claim, not the subject's other supported facts. Before finishing, check that meaningful subjects across the beginning, middle and end of the packet are represented, not only explicit main_characters or the most recent speakers. Return updates:[] only if no supported nonmanual entity contributions qualify; in that case include wi.empty_reason explaining why. No extra model request is available for WI.`;
