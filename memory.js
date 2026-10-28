export const VERSION = '0.1.0';
export const OWNER = 'worldMemory';
export const TYPES = ['character', 'place', 'object', 'organization', 'lore'];
export const normalize = text => String(text || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
export const signature = value => JSON.stringify(value);
export const entryMeta = entry => entry?.extensions?.[OWNER];
export const fingerprint = entry => signature([entry.comment, entry.key, entry.content, entry.constant, entry.disable]);
export const packetSignature = packet => signature([packet.text, packet.sourceMessageIds, packet.sources.map(source => [source.id, source.text])]);
export const sourceLabel = packet => packet.sources.length ? packet.sources.map(source => source.index).join(', ') : 'legacy summary';

export function parseResult(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let result;
    try { result = JSON.parse(raw); }
    catch { throw new Error('The model did not return JSON. Existing WI was kept. Check the connection or retry Update WI.'); }
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
Return JSON only. You are not the RP narrator. The saved L0 summary and its supplied played messages are evidence; existing record facts are separately sourced prior evidence. Never import author secrets, predictions or unsupported player/NPC actions.
Preserve the narrative summary's role: World Info is a reusable reference about an identifiable person, place, object or group, not a second chronological scene report. Keep uncertainty and speaker attribution. An attempt, permission, promise, photograph on undeveloped film and verified result are different things.
CHARACTERS ARE REQUIRED: maintain separate character profiles for the principal named people who act or speak in the supplied evidence, including the player's actual character when known. Record distinguishing traits actually established, role, meaningful relationships, knowledge boundaries and lasting changes. Do not treat a GM/scenario card title as a person. Do not turn every briefly mentioned name into a major character. Explicit main-character names are always tracked, but absent evidence must not be invented.
Use the supplied native UID for existing records, including empty main-profile placeholders. Return at most one update per UID. A matching word, surname or inflection does not establish identity. Never combine different people. uid:null means a genuinely new subject, not a rename of a listed record. Return only records receiving evidence from this packet; no change is valid.
For each record return facts supported ONLY by the current packet (not a copy of old facts), and content as the COMPLETE concise reference merging the supplied retained facts with those new facts. Later supported changes replace earlier state, not earlier history. Repeated old facts need not be repeated in facts. Correct uncertainty rather than invent a resolution.
Prefer ordinary meaningful keys and observed name aliases. Do not generate inflection regexes, broad keys such as documents/people/everything, invented name forms, or ST instructions. Russian WI Forms will handle dictionary inflections.
Schema: {"updates":[{"uid":0 or null,"name":"specific subject","type":"character|place|object|organization|lore","main":true or false,"keys":["ordinary keyword"],"facts":"only this packet's supported contribution","content":"complete merged reference"}]}.`;
