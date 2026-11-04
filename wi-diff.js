import { OWNER, TYPES, compactRevision, fingerprint, packetSignature } from './memory.js';

// A saved journal determines this chat's write protocol even on another
// installation whose global opt-in setting is off. Never mutate that setting.
export const usesWIDiffs = (settings = {}, memory = null) => Boolean(settings.wiDiffs || memory?.wiDiffState);

// Pure WI state only. Raw messages, L0, native books and their manual entries are never changed here.
const clone = value => structuredClone(value);
const fail = message => { throw new Error(`WI diff: ${message}`); };
const list = value => Array.isArray(value) ? value : [];
const manual = entry => {
    const meta = entry?.extensions?.[OWNER];
    return Boolean(meta?.manual || meta?.lastGenerated && meta.lastGenerated !== fingerprint(entry));
};
const subjectForUID = uid => `uid:${uid}`;
const validUID = uid => Number.isInteger(uid) && uid >= 0;
const unique = values => [...new Set(values)];
const textLines = facts => unique(String(facts || '').split(/\r?\n/).map(text => text.trim()).filter(Boolean));
const claimRevision = claim => compactRevision([claim.subject, claim.name, claim.type, claim.main,
    claim.keys, claim.text, claim.packetId, claim.sources]);
const head = claims => compactRevision(claims);
const sourceMap = sources => sources instanceof Map ? Object.fromEntries(sources) : sources || {};
const within = (refs, sources, cutoff) => Object.keys(refs || {}).length > 0
    && Object.entries(refs).every(([id, revision]) => sources[id]?.revision === revision
        && Number.isFinite(sources[id].index) && sources[id].index <= cutoff);
const refsFor = (ids, sources, through) => {
    if (!ids?.length || new Set(ids).size !== ids.length) fail('a complete, unique source set is required');
    const refs = {};
    for (const id of ids) {
        const source = sources[id];
        if (!source || typeof source.revision !== 'string' || !source.revision
            || !Number.isFinite(source.index) || source.index > through) fail(`missing, changed or future source ${id}`);
        refs[id] = source.revision;
    }
    return refs;
};
function recordsFrom(claims) {
    const groups = new Map();
    for (const claim of claims) {
        if (!groups.has(claim.subject)) groups.set(claim.subject, []);
        groups.get(claim.subject).push(claim);
    }
    return [...groups].map(([subject, items]) => {
        items.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const latest = items.at(-1);
        return { subject, uid: latest.uid, name: latest.name, type: latest.type,
            main: items.some(item => item.main), keys: unique(items.flatMap(item => item.keys)),
            facts: items.map(item => item.text).join('\n'), claims: clone(items) };
    });
}

/** Historical extraction view: no live content, late aliases, manual or foreign rows. */
export function projectLegacyWI(book, packets, { owner, cutoff = Infinity, omitPacketId = null } = {}) {
    const byPacket = new Map(list(packets).map(packet => [packet.id, packet]));
    const claims = [];
    for (const entry of Object.values(book?.entries || {})) {
        const meta = entry?.extensions?.[OWNER];
        if (!owner || meta?.owner !== owner || manual(entry) || !validUID(entry.uid)) continue;
        for (const [packetId, contribution] of Object.entries(meta.contributions || {})) {
            if (packetId === omitPacketId) continue;
            const packet = byPacket.get(packetId), ids = contribution.sourceMessageIds;
            if (!packet || packet.stale || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
                || ids.length !== packet.sourceMessageIds?.length
                || ids.some(id => !packet.sourceMessageIds.includes(id))) continue;
            const sources = new Map(list(packet.sources).map(source => [source.id, source]));
            if (!ids.every(id => Number.isFinite(sources.get(id)?.index) && sources.get(id).index <= cutoff)) continue;
            if (contribution.packetRevision && contribution.packetRevision !== compactRevision(packetSignature(packet))) continue;
            const refs = Object.fromEntries(ids.map(id => [id, packet.sourceFingerprints?.[id]]));
            if (Object.values(refs).some(value => typeof value !== 'string' || !value)) continue;
            if (contribution.sourceFingerprints && ids.some(id => contribution.sourceFingerprints[id] !== refs[id])) continue;
            const name = contribution.subjectName?.trim() || `WI ${entry.uid}`;
            const type = TYPES.includes(contribution.subjectType) ? contribution.subjectType : 'lore';
            const order = Math.min(...ids.map(id => sources.get(id).index));
            const through = Math.max(...ids.map(id => sources.get(id).index));
            for (const text of textLines(contribution.facts)) {
                const claim = { id: `legacy:${entry.uid}:${packetId}:${compactRevision(text)}`,
                    subject: subjectForUID(entry.uid), uid: entry.uid, name, type,
                    main: Boolean(contribution.subjectMain), keys: [name], text, packetId,
                    sources: refs, order, acceptedThrough: through, legacy: true };
                claim.revision = claimRevision(claim); claims.push(claim);
            }
        }
    }
    return recordsFrom(claims);
}

export function createWIDiffState({ owner, book, branch = owner, records = [] } = {}) {
    if (!owner || !book || !branch) fail('owner, book and branch are required');
    const claims = clone(list(records).flatMap(record => list(record.claims)));
    const seen = new Set();
    for (const claim of claims) {
        if (!claim.id || seen.has(claim.id) || claim.revision !== claimRevision(claim)) fail('invalid initial claim');
        seen.add(claim.id);
    }
    return { version: 1, owner, book, branch, confirmed: { head: head(claims), claims },
        pending: null, receipts: {}, lastReview: null };
}

/** Sources are supplied by the caller from the CURRENT selected branch. */
export function getWIDiffContext(state, { sources, cutoff = Infinity, protectedUIDs = [] } = {}) {
    sources = sourceMap(sources);
    const blocked = new Set(protectedUIDs);
    const claims = state.confirmed.claims.filter(claim => !blocked.has(claim.uid) && claim.acceptedThrough <= cutoff
        && within(claim.sources, sources, cutoff)
        && !(claim.retired && claim.retired.through <= cutoff && within(claim.retired.sources, sources, cutoff)));
    const pending = state.pending && state.pending.through <= cutoff
        && within(state.pending.sources, sources, cutoff) ? clone(state.pending) : null;
    return { version: 1, owner: state.owner, book: state.book, branch: state.branch,
        baseHead: state.confirmed.head, records: recordsFrom(claims), pending,
        stale: state.confirmed.claims.some(claim => !within(claim.sources, sources, Infinity)
            || claim.retired && !within(claim.retired.sources, sources, Infinity)),
        pendingStale: Boolean(state.pending && (!pending || state.pending.baseHead !== state.confirmed.head)) };
}

function validateState(state) {
    if (state?.version !== 1 || !state.owner || !state.book || !state.branch
        || !Array.isArray(state.confirmed?.claims) || state.confirmed.head !== head(state.confirmed.claims)) fail('invalid state/head');
}

/** Accept/reject the OLD proposal, then stage the NEW one. Returns a clone; never writes native WI. */
export function applyWIDiffResponse(state, wire, options = {}) {
    validateState(state);
    if (wire?.version !== 1 || !Array.isArray(wire.add) || !Array.isArray(wire.remove)) fail('expected version 1, add[] and remove[]');
    const { packetId, through, proposalId, sourceMessageIds, protectedUIDs = [], allowedUIDs = [] } = options;
    if (!packetId || !proposalId || !Number.isFinite(through)) fail('packetId, proposalId and through are required');
    for (const key of ['owner', 'book', 'branch']) if (options[key] !== undefined && options[key] !== state[key]) fail(`${key} binding changed`);
    const wireRevision = compactRevision([wire, packetId, through, sourceMessageIds]);
    if (state.receipts?.[proposalId]) {
        if (state.receipts[proposalId] !== wireRevision) fail('proposal ID reused for a different response');
        return clone(state);
    }
    const sources = sourceMap(options.sources), refs = refsFor(sourceMessageIds, sources, through);
    const view = getWIDiffContext(state, { sources, cutoff: through });
    if (view.stale) fail('confirmed base sources changed; rebuild the affected prefix first');
    if (state.confirmed.claims.some(claim => claim.acceptedThrough > through
        || !within(claim.sources, sources, through)
        || claim.retired && claim.retired.through > through)) fail('confirmed base extends beyond this prefix; create a prefix state first');
    if (typeof options.baseHead !== 'string' || options.baseHead !== state.confirmed.head) fail('response base changed or is missing');
    const blocked = new Set(protectedUIDs);
    const checkProtected = claim => { if (validUID(claim.uid) && blocked.has(claim.uid)) fail('manual or foreign UID is read-only'); };
    const next = clone(state);
    if (next.pending) {
        const pending = next.pending, review = wire.review;
        if (!review || review.proposalId !== pending.id || !['accept', 'reject'].includes(review.decision)) fail('review must address the pending proposal');
        if (review.decision === 'accept') {
            if (pending.baseHead !== next.confirmed.head || !within(pending.sources, sources, through)) fail('pending base or source revision changed');
            for (const addition of pending.add) checkProtected(addition);
            for (const removal of pending.remove) {
                const claim = next.confirmed.claims.find(item => item.id === removal.id);
                if (!claim || claim.revision !== removal.revision || claim.retired) fail('remove target changed');
                checkProtected(claim);
                claim.retired = { through, sources: { ...clone(pending.sources), ...clone(refs) }, proposalId: pending.id };
            }
            for (const addition of pending.add) next.confirmed.claims.push({ ...addition, acceptedThrough: through });
            next.confirmed.head = head(next.confirmed.claims);
        }
        next.lastReview = { proposalId: pending.id, decision: review.decision, through };
        next.pending = null;
    } else if (wire.review !== null && wire.review !== undefined) fail('no matching pending proposal');

    const active = getWIDiffContext(next, { sources, cutoff: through }).records.flatMap(record => record.claims);
    const existingUIDs = new Set([...allowedUIDs, ...active.map(claim => claim.uid).filter(validUID)]);
    const removed = new Set(), removals = [];
    for (const target of wire.remove) {
        const claim = active.find(item => item.id === target?.id);
        if (!claim || claim.revision !== target.revision || removed.has(target.id)) fail('remove requires a unique visible claim ID and exact revision');
        checkProtected(claim); removed.add(target.id); removals.push({ id: target.id, revision: target.revision });
    }
    const additions = [], subjects = new Map();
    for (const update of wire.add) {
        if (!update || (update.uid !== null && !validUID(update.uid)) || typeof update.name !== 'string'
            || !update.name.trim() || !TYPES.includes(update.type) || typeof update.facts !== 'string'
            || typeof update.main !== 'boolean' || !Array.isArray(update.keys)
            || update.keys.some(key => typeof key !== 'string' || !key.trim())) fail('invalid add fields');
        if (update.uid !== null && (!existingUIDs.has(update.uid) || blocked.has(update.uid))) fail('unknown, manual or foreign UID');
        const unbound = update.uid === null && active.find(claim => claim.uid === null && claim.subject === update.subject);
        if (update.uid === null && !unbound && (typeof update.subject !== 'string' || !update.subject.startsWith('new:') || update.subject.length <= 4)) fail('new subject needs a proposal-local new: handle');
        const subject = update.uid === null ? unbound?.subject || `${proposalId}:${update.subject}`
            : active.find(claim => claim.uid === update.uid)?.subject || subjectForUID(update.uid);
        const identity = compactRevision([update.uid, update.name, update.type, update.main, update.keys]);
        if (subjects.has(subject) && subjects.get(subject) !== identity) fail('one subject has conflicting identity fields');
        subjects.set(subject, identity);
        const lines = textLines(update.facts);
        if (!lines.length) fail('add needs source-backed facts');
        for (const text of lines) {
            const claim = { id: `${proposalId}:add:${additions.length}`, subject, uid: update.uid,
                name: update.name.trim(), type: update.type, main: update.main,
                keys: unique(update.keys.map(key => key.trim())), text, packetId, sources: clone(refs),
                order: Math.min(...sourceMessageIds.map(id => sources[id].index)), contextThrough: through };
            claim.revision = claimRevision(claim); additions.push(claim);
        }
    }
    if (additions.length || removals.length) next.pending = { id: proposalId, packetId, through,
        contextThrough: through, baseHead: next.confirmed.head, sources: refs, add: additions, remove: removals };
    next.receipts[proposalId] = wireRevision;
    return next;
}

/** Bind accepted new subjects to allocated native UIDs. Does not allocate or edit book entries. */
export function bindWIDiffUIDs(state, mapping) {
    validateState(state);
    const next = clone(state), used = new Map();
    const all = [...next.confirmed.claims, ...list(next.pending?.add)];
    for (const claim of all) if (validUID(claim.uid)) used.set(claim.uid, claim.subject);
    for (const [subject, uid] of Object.entries(mapping || {})) {
        if (!validUID(uid) || !next.confirmed.claims.some(claim => claim.subject === subject)) fail('invalid accepted subject/UID binding');
        if (used.has(uid) && used.get(uid) !== subject) fail('native UID collision');
        used.set(uid, subject);
        for (const claim of all.filter(item => item.subject === subject)) {
            if (claim.uid !== null && claim.uid !== uid) fail('subject UID already bound');
            claim.uid = uid;
        }
    }
    next.confirmed.head = head(next.confirmed.claims);
    if (next.pending) next.pending.baseHead = next.confirmed.head;
    return next;
}
