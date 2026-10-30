// Growing L0 records. No ST globals, token limits, promotions or source-message writes.
import { currentStorySpine } from './story-spine.js';
export const ARCHIVE_VERSION = 1;
// Same text revision used by saved memory_metadata and existing source spans.
const hash = text => {
    let a = 2166136261, b = 5381;
    for (const char of String(text)) { const n = char.codePointAt(0); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
};
const copy = value => structuredClone(value);
const unique = values => [...new Set(values || [])];
const messageId = message => message.sc_message_id || message.extra?.sc_message_id || message.id;
const set = (object, key, value) => Object.defineProperty(object, key,
    { value, enumerable: true, configurable: true, writable: true });

export function createArchive(saved = null) {
    if (saved && saved.version !== ARCHIVE_VERSION) throw new Error('Unsupported L0 archive version.');
    return { version: ARCHIVE_VERSION, records: {}, sources: {}, legacy: {}, ...copy(saved || {}) };
}

/** Returns copies; consumers publish changes explicitly through putPacket. */
export function readArchive(archive, { includeDeleted = false, effective = false } = {}) {
    const records = Object.values(archive.records).filter(record => includeDeleted || !record.deleted);
    if (!effective) return copy(records);
    // Imported manual revisions replace their represented roots in the working view.
    // All original roots and shadowed revisions remain in records and in exports.
    const selected = [], represented = new Set();
    const revisions = records.filter(record => record.kind !== 'l0').sort((a, b) =>
        Number(b.manual) - Number(a.manual) || (b.timestamp || 0) - (a.timestamp || 0)
        || (b.legacyPriority || 0) - (a.legacyPriority || 0));
    for (const record of revisions) {
        const roots = record.l0SourceIds || [];
        if (roots.length && roots.some(id => represented.has(id))) continue;
        selected.push(record);
        roots.forEach(id => represented.add(id));
    }
    selected.push(...records.filter(record => record.kind === 'l0' && !represented.has(record.id)));
    return copy(selected);
}

export function readPacket(archive, id, { includeDeleted = false } = {}) {
    const record = Object.hasOwn(archive.records, id) ? archive.records[id] : null;
    return record && (includeDeleted || !record.deleted) ? copy(record) : null;
}

export function putPacket(archive, packet) {
    if (!packet || typeof packet.id !== 'string' || !packet.id || typeof packet.text !== 'string' || !packet.text.trim()) {
        throw new Error('An archive packet needs a stable ID and nonempty text.');
    }
    const previous = Object.hasOwn(archive.records, packet.id) ? archive.records[packet.id] : null;
    const record = { ...copy(previous || {}), ...copy(packet), kind: packet.kind || previous?.kind || 'l0' };
    record.sourceMessageIds = unique(record.sourceMessageIds);
    record.l0SourceIds = unique(record.l0SourceIds || (record.kind === 'l0' ? [record.id] : []));
    delete record.deleted; delete record.deletedAt;
    set(archive.records, record.id, record);
    return copy(record);
}

/** A tombstone prevents a later legacy import from resurrecting a user deletion. */
export function deletePacket(archive, id) {
    if (!Object.hasOwn(archive.records, id) || archive.records[id].deleted) return false;
    archive.records[id].deleted = true;
    archive.records[id].deletedAt = Date.now();
    return true;
}

/** Accepts a SC store or an offline {store, packets, tail, currentPost} cohort. */
export function importLegacyArchive(archive, input, { source = 'summaryception' } = {}) {
    const store = input?.store || input;
    if (!store || !Array.isArray(store.layers)) throw new Error('Legacy memory has no layers array.');
    const result = { added: 0, kept: 0, roots: 0, revisions: 0, legacySummaries: 0 };
    if (!Object.hasOwn(archive.legacy, source)) set(archive.legacy, source, copy(store));
    const packets = new Map((input.packets || []).map(packet => [packet.id, packet]));
    const live = new Map((store.layers[0] || []).filter(Boolean).map((packet, index) =>
        [packet.id || `legacy-l0:${hash(JSON.stringify([source, index, packet.text]))}`, packet]));
    const roots = unique([...Object.keys(store.l0Archive || {}), ...live.keys(), ...packets.keys()]);
    const insert = record => {
        if (Object.hasOwn(archive.records, record.id)) { result.kept++; return; }
        putPacket(archive, record); result.added++;
    };
    // Optional offline original sources are stored once per ID, not copied into every L0.
    for (const row of [...(input.packets || []).flatMap(packet => packet.sources || []),
        ...(input.tail || []), input.currentPost].filter(Boolean)) {
        if (!row.id) continue;
        const saved = archive.sources[row.id];
        if (saved && (saved.text !== row.text || saved.name !== row.name || Boolean(saved.isUser) !== Boolean(row.isUser))) {
            throw new Error(`Conflicting original source revision for ${row.id}. Import it under its own archive.`);
        }
        if (!saved) set(archive.sources, row.id, copy(row));
    }
    for (const id of roots) {
        const snapshot = packets.get(id), archived = store.l0Archive?.[id], current = live.get(id);
        const { sources: _sources, ...snapshotFields } = snapshot || {};
        const record = { ...snapshotFields, ...copy(archived || {}), ...copy(current || {}), id, kind: 'l0',
            l0SourceIds: [id], legacyRef: { source, archiveId: id },
            ...(current && archived && current.text !== archived.text ? { manual: true, liveRevision: true } : {}) };
        // Live L0 text is authoritative, but omitted link/usage fields retain their archive values.
        for (const field of ['sourceMessageIds', 'sourceFingerprints', 'usage', 'memoryMetadata']) {
            if (record[field] === undefined && archived?.[field] !== undefined) record[field] = copy(archived[field]);
        }
        insert(record); result.roots++;
    }
    const rootSources = ids => unique(ids.flatMap(id => archive.records[id]?.sourceMessageIds || []));
    for (let layer = 1; layer < store.layers.length; layer++) {
        for (const [index, snippet] of (store.layers[layer] || []).entries()) {
            if (!snippet) continue;
            const rootIds = unique(snippet.l0SourceIds), missing = rootIds.filter(id => !roots.includes(id));
            for (const revision of snippet.compressionOverrides || []) {
                const ids = unique(revision.l0SourceIds);
                if (typeof revision.text !== 'string' || !revision.text.trim()) continue;
                const id = `manual:${hash(JSON.stringify([source, ids.slice().sort(), revision.text]))}`;
                const knownSources = rootSources(ids), missingRoots = ids.some(root => !roots.includes(root));
                const fingerprints = Object.assign({}, ...ids.map(root => archive.records[root]?.sourceFingerprints || {}));
                insert({ ...copy(revision), id, kind: 'manual-revision', manual: true, l0SourceIds: ids,
                    sourceMessageIds: unique([...knownSources, ...(revision.sourceMessageIds || []),
                        ...(missingRoots || !ids.length ? snippet.sourceMessageIds || [] : [])]),
                    ...(Object.keys(fingerprints).length ? { sourceFingerprints: fingerprints } : {}),
                    timestamp: snippet.timestamp, legacyPriority: layer, legacyRef: { source, layer, index },
                    originalL0Unavailable: missingRoots });
                result.revisions++;
            }
            if (!snippet.originalL0Unavailable && rootIds.length && !missing.length) continue;
            if (typeof snippet.text !== 'string' || !snippet.text.trim()) continue;
            insert({ ...copy(snippet), id: `legacy:${source}:${snippet.id || `${layer}:${index}`}`,
                kind: 'legacy-summary', originalL0Unavailable: true, missingL0SourceIds: missing,
                legacyPriority: layer, legacyRef: { source, layer, index, snippetId: snippet.id || null } });
            result.legacySummaries++;
        }
    }
    return result;
}

/** Matches Summaryception's role/name/trimmed-text fingerprint, without assigning IDs. */
export function sourceFingerprint(message) {
    const isUser = Boolean(message.is_user ?? message.isUser);
    const text = JSON.stringify([isUser, message.name || (isUser ? 'User' : 'Assistant'),
        String(message.mes ?? message.text ?? '').trim()]);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        h1 = Math.imul(h1 ^ text.charCodeAt(i), 2654435761);
        h2 = Math.imul(h2 ^ text.charCodeAt(i), 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

/** Native context retains chat/metadata identity. With no chat, offline originals are used. */
export function archiveSnapshot(archive, context = {}, { effective = true } = {}) {
    const nativeChat = Array.isArray(context.chat), chat = nativeChat ? context.chat : [];
    const originals = nativeChat ? chat : Object.values(archive.sources);
    const messages = new Map(originals.flatMap((message, position) => {
        const id = messageId(message);
        if (!id) return [];
        const native = message.mes !== undefined || message.is_system !== undefined;
        const isUser = Boolean(message.is_user ?? message.isUser), text = message.mes ?? message.text ?? '';
        return [[id, { ...copy(message), id, index: nativeChat ? position : message.index ?? position,
            name: message.name || (isUser ? 'User' : 'Assistant'), isUser, text,
            hidden: native ? Boolean(message.is_system && (!message.extra?.sc_ghosted || message.extra?.sc_context?.manual))
                : Boolean(message.hidden), hint: message.extra?.worldMemoryHint || message.hint || null,
            fingerprint: sourceFingerprint(message) }]];
    }));
    const packets = readArchive(archive, { effective }).map((record, position) => {
        const ids = record.sourceMessageIds, sources = ids.map(id => messages.get(id)).filter(Boolean)
            .sort((a, b) => a.index - b.index);
        const fingerprints = Object.fromEntries(ids.map(id => [id, messages.has(id)
            ? `${messages.get(id).fingerprint}:${hash(messages.get(id).text)}` : null]));
        const textRevision = hash(record.text), metadata = record.memoryMetadata;
        const metadataCurrent = metadata?.textRevision === textRevision && (!metadata.sourceFingerprints
            || ids.every(id => metadata.sourceFingerprints[id] === fingerprints[id]));
        const packet = { ...record, textRevision, sources, sourceFingerprints: fingerprints,
            memoryMetadata: metadataCurrent ? copy(metadata) : null,
            stale: ids.some(id => !messages.has(id) && !record.unavailableSourceIds?.includes(id)) || Boolean(record.sourceFingerprints
                && ids.some(id => !(!messages.has(id) && record.unavailableSourceIds?.includes(id)) && record.sourceFingerprints[id] !== undefined
                    && record.sourceFingerprints[id] !== messages.get(id)?.fingerprint
                    && record.sourceFingerprints[id] !== fingerprints[id])),
            sourceStatus: ids.length && sources.length === ids.length ? 'linked' : 'summary-only',
            orderKnown: Boolean(sources.length || Number.isFinite(record.turnRange?.[0])
                || (Number.isFinite(record.order) && record.order < Number.MAX_SAFE_INTEGER)),
            order: sources.length ? Math.min(...sources.map(source => source.index)) : record.order ?? record.turnRange?.[0] ?? position };
        const spineFingerprints = record.storySpine?.sourceFingerprints;
        packet.storySpine = (record.storySpine?.sourceStatus === 'summary-only' || !spineFingerprints
            || ids.every(id => spineFingerprints[id] === fingerprints[id]))
            && currentStorySpine(packet) ? copy(record.storySpine) : null;
        if (record.storySpine && !packet.storySpine) packet.storySpineError = 'Story skeleton no longer matches the saved L0 or its source messages.';
        return packet;
    }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return { chatId: context.chatId || '', metadata: context.chatMetadata, chat,
        characterName: context.characterName ?? context.characters?.[context.characterId]?.name ?? '',
        playerName: context.playerName ?? context.name1 ?? 'User', historyReplacementSafe: true, packets };
}

// Explicit aliases for callers that name the backend rather than its packet operations.
export { putPacket as putArchivePacket, deletePacket as deleteArchivePacket, archiveSnapshot as snapshotArchive,
    readPacket as readArchivePacket, importLegacyArchive as importLegacyStore };
