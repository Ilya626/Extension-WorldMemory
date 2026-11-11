import { OWNER, entryMeta, detectManual, packetSignature, compactRevision } from './memory.js';
import { sourceFingerprint } from './archive-store.js';
import { hash } from './history.js';

// Copy confirmed DIFF evidence into the existing packet-owned contribution store.
// The original journal, including pending and rejected decisions, is never modified.
export function migrateConfirmedContributions(book, memory, snapshot) {
    const journal = memory.wiDiffState;
    if (!journal || journal.owner !== memory.owner || journal.book !== memory.book || journal.branch !== memory.owner)
        throw new Error('WI journal binding changed; contributions were not migrated.');
    const sources = Object.fromEntries(snapshot.chat.map((message, index) => [message.sc_message_id || message.extra?.sc_message_id,
        { index, revision: `${sourceFingerprint(message)}:${hash(message.mes || '')}` }]).filter(([id]) => id));
    const valid = refs => Object.keys(refs || {}).length && Object.entries(refs).every(([id, revision]) => sources[id]?.revision === revision);
    const packets = new Map(snapshot.packets.map(packet => [packet.id, packet]));
    const reviewers = new Map();
    for (const record of Object.values(memory.archive?.records || {})) {
        const context = record.memoryMetadata?.wiContext, review = record.memoryMetadata?.wiDiff?.review;
        if (!context?.diff || !review?.proposalId || !['accept','partial'].includes(review.decision)) continue;
        const ids = context.sourceMessageIds || [], refs = Object.fromEntries(ids.map(id => [id,context.sourceFingerprints?.[id]]));
        if (ids.length && ids.every(id => typeof refs[id] === 'string')) reviewers.set(review.proposalId, {review,refs,through:context.through});
    }
    for (const [id, history] of Object.entries(journal.reviewHistory || {}))
        if (history.review && Object.keys(history.sources || {}).length) reviewers.set(id,{review:history.review,refs:history.sources,through:history.through});
    const reviewRefs = claim => {
        if (claim.legacy) return null;
        const item = reviewers.get(claim.id.split(':add:')[0]);
        return item && item.through === claim.acceptedThrough && (item.review.decision === 'accept'
            || item.review.items?.some(decision => decision.id === claim.id && decision.decision === 'accept')) ? item.refs : null;
    };
    // Editorial replacement claims can have a synthetic packet ID. Bind them
    // to the explicitly corrected original claim, never by entity name alone.
    const originals = new Map(journal.confirmed.claims.map(claim => [claim.id,claim]));
    const editorialPacket = new Map();
    for (const correction of journal.editorialCorrections || []) for (const item of correction.items || []) {
        const original = originals.get(item.claimId);
        const matches = journal.confirmed.claims.filter(claim => claim.text === item.replacement && claim.uid === original?.uid
            && JSON.stringify(claim.sources) === JSON.stringify(original?.sources));
        if (original && matches.length === 1 && packets.has(original.packetId)) editorialPacket.set(matches[0].id, original.packetId);
    }
    const next = structuredClone(book), groups = new Map(), unresolved = [], invalidated = new Set();
    for (const claim of journal.confirmed.claims) {
        const packet = packets.get(claim.packetId) || packets.get(editorialPacket.get(claim.id));
        let entry = Number.isInteger(claim.uid) ? next.entries[claim.uid] : Object.values(next.entries).find(row => entryMeta(row)?.diff?.subject === claim.subject);
        if (!entry || entryMeta(entry)?.owner !== memory.owner || detectManual(entry)) {
            unresolved.push({id:claim.id, reason:'protected-or-missing-uid'}); continue;
        }
        if (!packet) {
            unresolved.push({id:claim.id, reason:'source-or-retirement-changed'});
            if (!claim.retired) invalidated.add(entry.uid);
            if (entryMeta(entry).contributions?.[claim.packetId]?.contributionOrigin !== 'l0') delete entryMeta(entry).contributions?.[claim.packetId];
            continue;
        }
        if (!groups.has(entry.uid)) groups.set(entry.uid, new Map());
        const byPacket = groups.get(entry.uid);
        if (!byPacket.has(packet.id)) byPacket.set(packet.id, []);
        const refs = reviewRefs(claim);
        const sourceValid = !packet.stale && valid(claim.sources);
        if (!sourceValid) { unresolved.push({id:claim.id, reason:'source-changed'}); if (!claim.retired) invalidated.add(entry.uid); }
        if (refs && !valid(refs)) { unresolved.push({id:claim.id, reason:'review-source-changed'}); if (!claim.retired) invalidated.add(entry.uid); }
        if (claim.retired && !valid(claim.retired.sources)) unresolved.push({id:claim.id, reason:'retirement-source-changed'});
        byPacket.get(packet.id).push({claim, refs, sourceValid, reviewValid:!refs || valid(refs)});
    }
    const affected = [];
    for (const [uid, byPacket] of groups) {
        const meta = entryMeta(next.entries[uid]);
        const before = JSON.stringify(meta.contributions);
        for (const [id, entries] of byPacket) {
            const existing = meta.contributions[id];
            if (existing?.contributionOrigin === 'l0' && !existing.journalClaims) continue;
            const claims = entries.map(item=>item.claim), packet = packets.get(id);
            const active = entries.filter(item => !item.claim.retired && item.sourceValid && item.reviewValid).map(item=>item.claim);
            // Keep the complete source journal even when every claim is retired.
            const facts = [...new Set([...active.map(claim=>claim.text), existing?.preservedFacts, existing?.localFacts].filter(Boolean))].join('\n');
            meta.contributions[id] = { ...(existing?.contributionOrigin === 'l0' ? existing : {}), facts, sourceMessageIds:[...packet.sourceMessageIds],
                sourceFingerprints:structuredClone(packet.sourceFingerprints), order:packet.order,
                subjectName:existing?.contributionOrigin === 'l0' ? existing.subjectName : claims.at(-1).name,
                subjectType:existing?.contributionOrigin === 'l0' ? existing.subjectType : claims.at(-1).type,
                packetRevision:compactRevision(packetSignature(packet)), journalClaims:structuredClone(claims),
                reviewDependencies:entries.map(item=>({id:item.claim.id,kind:item.refs ? 'recorded-review' : 'legacy-unknown',
                    ...(item.refs ? {sourceFingerprints:structuredClone(item.refs)} : {})})) };
        }
        if (before !== JSON.stringify(meta.contributions)) affected.push(uid);
    }
    return {book:next, unresolved, affected, invalidated:[...invalidated]};
}
