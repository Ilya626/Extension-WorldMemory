import { OWNER, entryMeta, fingerprint, markGenerated, signature, compactRevision } from './memory.js';
import { sourceFingerprint } from './archive-store.js';
import { memoryTextRevision } from './vendor/summaryception/memory-metadata.js';
import { projectLegacyWI, createWIDiffState, getWIDiffContext, applyWIDiffResponse, bindWIDiffUIDs } from './wi-diff.js';

export const DIFF_SYSTEM = `Maintain source-backed entity World Info, separate from chronological history. Inside the ONE existing <memory_metadata> JSON object, add a sibling property "wiDiff" beside lprime and facts. Never emit a nested "memory_metadata" property, a second object, or wi.updates. Valid shape: {"wiDiff":{"version":1,"review":null,"add":[{"uid":null,"subject":"new:1","name":"Observed name","type":"character","main":false,"keys":["Observed name"],"facts":"One supported clause per line."}],"remove":[]}}.
For an existing entity, uid is its supplied integer. Other allowed types are place, object, organization and lore. A removal is an object with the exact supplied claim id and revision. When pending exists, review is {"proposalId":"exact pending ID","decision":"accept"} or the same object with decision "reject". This replaces review:null; it is not an extra object. Facts follow the requested prose language, while names retain their observed script.
Review the previous pending diff against its supplied pending_sources and confirmed evidence; it is NOT confirmed yet. Accept it only if supported, otherwise reject it and propose corrected clauses. Give new additions only from this packet's new_sources; saved L0 is navigation, not proof. Cover meaningful named secondary characters and reusable places/objects/groups as well as main actors. Preserve speaker attribution, uncertainty, conditions, plans versus outcomes, and player agency. Keep names and aliases in their observed script. A repeated name alone does not establish identity. Use existing native UIDs; never edit manual/foreign records. A genuinely new subject uses one consistent new:* handle. If accepting a previous new subject whose UID is still null, use its exact pending add.subject handle to extend it, rather than inventing another new:* entity. Do not translate, restate or copy retained_evidence or pending as new additions, even if their prose is in another language. Keep prior wording; add only a genuinely new clause from new_sources. Use exact remove IDs to retire outdated CURRENT conditions (location, pending action, unresolved state) when new_sources settle or change them. Keep completed historical events and their originals. New changes remain pending until a later review. With no pending use review:null. With no justified changes use empty add/remove arrays. For explicit review_only return the review and empty add/remove arrays.`;

const clone = value => structuredClone(value);
const error = text => { throw new Error(`WI diff: ${text}`); };
const idOf = message => message.sc_message_id || message.extra?.sc_message_id || message.id;
const manual = entry => Boolean(entryMeta(entry)?.manual || entryMeta(entry)?.lastGenerated
    && entryMeta(entry).lastGenerated !== fingerprint(entry));
const flat = records => records.flatMap(record => record.claims);
// Installation owner/book/branch pointers are rebound by complete import.
const backfillRevision = state => compactRevision(state?.backfillPending
    ? [state.backfillPending.state.confirmed, state.backfillPending.state.pending, state.backfillPending.state.receipts] : null);

export function createWIDiffRuntime({ ctx, snapshot, getBook, saveBook, initializeEntry, saveState }) {
    const memory = () => ctx().chatMetadata?.[OWNER];
    const capture = () => {
        const context = ctx(), view = snapshot({ effective: false }), sources = {}, originals = {};
        for (const [index, message] of (view.chat || context.chat || []).entries()) {
            const id = idOf(message); if (!id) continue;
            const text = message.mes ?? message.text ?? '';
            sources[id] = { index, revision: `${sourceFingerprint(message)}:${memoryTextRevision(text)}` };
            originals[id] = { id, index, name: message.name || (message.is_user ? 'User' : 'Assistant'), text };
        }
        return { metadata: context.chatMetadata, chat: context.chat, memory: memory(), view, sources, originals };
    };
    const guard = run => {
        if (ctx().chatMetadata !== run.metadata || ctx().chat !== run.chat || memory() !== run.memory)
            error('chat changed');
    };
    const binding = run => ({ owner: run.memory.owner, book: run.memory.book,
        authorBook: run.memory.wiSourceBook || '', branch: run.memory.owner });
    const assertBinding = (run, stamp) => {
        guard(run);
        for (const [key, value] of Object.entries(binding(run))) if (stamp[key] !== value) error(`${key} binding changed`);
    };
    const protectedUIDs = (book, owner) => Object.values(book?.entries || {})
        .filter(entry => entryMeta(entry)?.owner !== owner || manual(entry)).map(entry => entry.uid);
    const validRefs = (refs, sources) => Object.keys(refs || {}).length > 0
        && Object.entries(refs).every(([id, revision]) => sources[id]?.revision === revision);
    const checkRefs = (refs, run) => {
        if (!validRefs(refs, run.sources)) error('request originals changed or disappeared; saved response was kept');
    };

    async function prepare({ sourceIds = [], packetId, reviewOnly = false, backfillReview = false } = {}) {
        const book = await getBook(true), run = capture();
        if (!run.memory?.owner || !run.memory.book || !run.memory.wiSourceBook) error('choose a chat WI book first');
        if (!sourceIds.length || new Set(sourceIds).size !== sourceIds.length
            || sourceIds.some(id => !run.sources[id])) error('complete linked original source set is required');
        const indices = sourceIds.map(id => run.sources[id].index), through = Math.max(...indices);
        const before = reviewOnly ? through : Math.min(...indices) - 1;
        const record = run.view.packets.find(packet => packet.id === packetId);
        if (!reviewOnly && record && (record.stale || signature([...record.sourceMessageIds].sort()) !== signature([...sourceIds].sort())))
            error('prepare requires the complete unchanged packet source set');
        let state = run.memory.wiDiffState;
        if (!state) {
            state = createWIDiffState({ ...binding(run), records: projectLegacyWI(book, run.view.packets,
                { owner: run.memory.owner, cutoff: before, omitPacketId: packetId }) });
            run.memory.wiDiffState = state; await saveState(); guard(run);
        }
        assertBinding(run, { ...binding(run), owner: state.owner, book: state.book, branch: state.branch });
        const liveState = state;
        if (backfillReview) {
            if (!state.backfillPending) error('no earlier WI proposal awaits review');
            state = state.backfillPending.state;
        }
        const blocked = protectedUIDs(book, state.owner);
        // A rejected last packet may be retried after its call accepted the
        // PREVIOUS proposal. Those claims still come exclusively from earlier
        // originals; only their review boundary is this packet's end.
        const retryRejected = !reviewOnly && !state.pending && state.lastReview?.decision === 'reject'
            && state.lastReview.through === through && state.confirmed.claims.every(claim =>
                claim.acceptedThrough <= through && Object.keys(claim.sources).every(id => run.sources[id]?.index <= before));
        const cutoff = retryRejected ? through : before;
        let projected = getWIDiffContext(state, { sources: run.sources, cutoff, protectedUIDs: blocked });
        const historical = !reviewOnly && (state.pending?.through > cutoff
            || state.confirmed.claims.some(claim => claim.acceptedThrough > cutoff));
        if (historical) {
            if (liveState.backfillPending && liveState.backfillPending.state.pending?.packetId !== packetId)
                error('review the saved earlier WI proposal before preparing another one');
            if (projected.stale || getWIDiffContext(state, { sources: run.sources }).pendingStale)
                error('source/base changed; reconcile saved WI before preparing an earlier diff');
            const prefixRecords = clone(projected.records);
            // The historical view contains active claims only. A retirement
            // that happened later is not part of this prefix's state.
            for (const claim of flat(prefixRecords)) delete claim.retired;
            state = createWIDiffState({ ...binding(run), records: prefixRecords });
            projected = getWIDiffContext(state, { sources: run.sources, cutoff, protectedUIDs: blocked });
        }
        if (!historical && !reviewOnly && liveState.backfillPending)
            error('review the saved earlier WI proposal before preparing the next diff');
        // A backfill review may change the confirmed head while the later
        // proposal is still pending. Only a fresh explicit review sees that new
        // base; an old model response is never silently accepted against it.
        const rebaseReview = reviewOnly && !backfillReview && state.pending
            && state.pending.baseHead !== state.confirmed.head;
        if (rebaseReview) {
            state = clone(state); state.pending.baseHead = state.confirmed.head;
            projected = getWIDiffContext(state, { sources: run.sources, cutoff, protectedUIDs: blocked });
        }
        if (projected.stale || projected.pendingStale) error('source/base changed; reconcile saved WI before preparing another diff');
        if (state.confirmed.claims.some(claim => claim.acceptedThrough > cutoff
            || Object.keys(claim.sources).some(id => run.sources[id]?.index > before)))
            error('confirmed state is later than this packet; use a separate prefix state');
        const refs = {};
        for (const claim of state.confirmed.claims) Object.assign(refs, claim.sources, claim.retired?.sources);
        if (state.pending) Object.assign(refs, state.pending.sources);
        for (const id of sourceIds) refs[id] = run.sources[id].revision;
        checkRefs(refs, run);
        const proposalId = crypto.randomUUID();
        const stamp = { version: 1, ...binding(run), diff: true, baseHead: state.confirmed.head,
            proposalId, packetId, through, contextThrough: through, sourceMessageIds: [...sourceIds],
            sourceFingerprints: refs, reviewOnly, packetTextRevision: record ? memoryTextRevision(record.text) : null,
            ...(historical ? { historical: true, prefixState: state } : {}),
            ...(backfillReview ? { backfillReview: true } : {}),
            ...(rebaseReview ? { rebaseReview: true } : {}),
            ...((backfillReview || rebaseReview) ? { reviewedPacketId: state.pending?.packetId } : {}),
            ...((historical || backfillReview || rebaseReview) ? { liveHead: liveState.confirmed.head,
                livePending: compactRevision(liveState.pending), backfillRevision: backfillRevision(liveState) } : {}) };
        const proposed = new Map();
        for (const claim of projected.pending?.add || []) {
            if (!proposed.has(claim.subject)) proposed.set(claim.subject, { uid: claim.uid, subject: claim.subject,
                name: claim.name, type: claim.type, main: claim.main, keys: [...claim.keys], claims: [] });
            proposed.get(claim.subject).claims.push({ id: claim.id, revision: claim.revision, text: claim.text });
        }
        return { systemPrompt: DIFF_SYSTEM,
            context: { version: 1, review_only: reviewOnly, baseHead: stamp.baseHead,
                existing_index: projected.records.map(({ uid, subject, name, type, keys, main }) => ({ uid, subject, name, type, keys, main })),
                retained_evidence: projected.records.map(({ uid, subject, claims }) => ({ uid, subject,
                    claims: claims.map(({ id, revision, text, packetId }) => ({ id, revision, text, packetId })) })),
                pending: projected.pending ? { id: projected.pending.id, packetId: projected.pending.packetId,
                    through: projected.pending.through, baseHead: projected.pending.baseHead,
                    add: [...proposed.values()], remove: projected.pending.remove } : null,
                pending_sources: state.pending ? Object.keys(state.pending.sources).map(id => clone(run.originals[id])) : [],
                instruction: 'Confirmed references only. Pending is proposed, not established. New facts use only this packet new_sources. Review pending against pending_sources. No later book/index is supplied.' }, stamp };
    }

    async function materialize() {
        const book = await getBook(), run = capture(), state = run.memory?.wiDiffState;
        if (!book || !state) return { status: 'unchanged' };
        if (state.owner !== run.memory.owner || state.book !== run.memory.book || state.branch !== run.memory.owner)
            error('diff state belongs to another binding');
        const next = clone(book), blocked = protectedUIDs(book, state.owner);
        const legacy = projectLegacyWI(book, run.view.packets, { owner: state.owner });
        const stateView = getWIDiffContext(state, { sources: run.sources, protectedUIDs: blocked });
        // A changed ancestor invalidates dependent generated claims; keep their durable journal, never replay a model here.
        const confirmed = state.confirmed.claims.filter(claim => !stateView.stale || claim.legacy);
        const claims = new Map(flat(legacy).map(claim => [claim.id, claim]));
        for (const claim of confirmed) {
            if (claim.legacy && !claims.has(claim.id)) continue;
            if (validRefs(claim.sources, run.sources)) claims.set(claim.id, clone(claim));
        }
        const combined = createWIDiffState({ owner: state.owner, book: state.book, branch: state.branch,
            records: [{ claims: [...claims.values()] }] });
        const records = getWIDiffContext(combined, { sources: run.sources, protectedUIDs: blocked }).records;
        const legacyIDs = new Set(flat(legacy).map(claim => claim.id));
        const changedSubjects = new Set(state.confirmed.claims.filter(claim => !claim.legacy || claim.retired
            || !legacyIDs.has(claim.id)).map(claim => claim.subject));
        const packets = new Map(run.view.packets.map(packet => [packet.id, packet]));
        for (const entry of Object.values(next.entries)) if (entryMeta(entry)?.owner === state.owner && !manual(entry)
            && Object.keys(entryMeta(entry).contributions || {}).some(id => !packets.has(id) || packets.get(id).stale))
            changedSubjects.add(`uid:${entry.uid}`);
        const uidMap = {}, touched = new Set();
        for (const record of records) {
            let entry = record.uid === null ? Object.values(next.entries).find(item =>
                entryMeta(item)?.owner === state.owner && entryMeta(item)?.diff?.subject === record.subject) : next.entries[record.uid];
            if (entry && (entryMeta(entry)?.owner !== state.owner || manual(entry))) continue;
            if (!changedSubjects.has(record.subject) && !entryMeta(entry)?.diff) continue;
            if (!entry && record.uid !== null) continue; // A user-deleted native entry is not recreated silently.
            if (!entry) entry = initializeEntry(next, record.name, record.type, record.main);
            if (!entry) error('native entry allocation failed');
            if (record.uid === null) uidMap[record.subject] = entry.uid;
            touched.add(entry.uid);
            const meta = entryMeta(entry);
            entry.comment = record.name; entry.key = record.keys; entry.content = record.facts;
            meta.type = record.type; meta.main = Boolean(meta.main || record.main);
            meta.diff = { version: 1, subject: record.subject,
                claims: record.claims.filter(claim => !claim.legacy).map(claim => ({ ...clone(claim), uid: entry.uid })),
                retired: confirmed.filter(claim => claim.retired && claim.uid === entry.uid).map(claim => ({ id: claim.id, revision: claim.revision, ...clone(claim.retired) })) };
            markGenerated(entry);
        }
        for (const entry of Object.values(next.entries)) if (entryMeta(entry)?.owner === state.owner
            && (entryMeta(entry)?.diff || changedSubjects.has(`uid:${entry.uid}`)) && !manual(entry) && !touched.has(entry.uid)) {
            entry.content = ''; entryMeta(entry).diff = { version: 1, subject: entryMeta(entry).diff?.subject || `uid:${entry.uid}`,
                claims: [], retired: confirmed.filter(claim => claim.retired && claim.uid === entry.uid).map(clone) };
            markGenerated(entry);
        }
        guard(run);
        if (run.memory.wiDiffState !== state) error('confirmed state changed during materialization');
        if (signature(next) !== signature(book)) { await saveBook(next, run.metadata, book); guard(run); }
        // Save native allocation first. If interrupted, meta.diff.subject recovers the mapping on retry.
        if (run.memory.wiDiffState !== state) error('confirmed state changed during native write');
        if (Object.keys(uidMap).length) { run.memory.wiDiffState = bindWIDiffUIDs(state, uidMap); await saveState(); guard(run); }
        return { status: 'applied', records: records.length, stale: stateView.stale };
    }

    async function consume(packet) {
        const run = capture(), wire = packet.memoryMetadata?.wiDiff, stamp = packet.memoryMetadata?.wiContext;
        if (!wire || !stamp?.diff || stamp.version !== 1) error('no saved diff/context');
        assertBinding(run, stamp); checkRefs(stamp.sourceFingerprints, run);
        if (signature([...(packet.sourceMessageIds || [])].sort()) !== signature([...stamp.sourceMessageIds].sort()))
            error('packet source membership changed');
        if (!stamp.reviewOnly) {
            const live = run.view.packets.find(item => item.id === packet.id);
            if (!live || live.stale || memoryTextRevision(live.text) !== stamp.packetTextRevision
                || signature([...live.sourceMessageIds].sort()) !== signature([...stamp.sourceMessageIds].sort())) error('saved packet changed');
        } else if (wire.add?.length || wire.remove?.length) error('final review must not propose another diff');
        const state = run.memory.wiDiffState;
        if (!state) error('saved confirmed base is missing');
        const book = await getBook(); guard(run); assertBinding(run, stamp);
        if (run.memory.wiDiffState !== state) error('confirmed state changed while reading the native book');
        const fresh = capture(); checkRefs(stamp.sourceFingerprints, fresh);
        if ((stamp.backfillReview || stamp.rebaseReview) && state.receipts?.[stamp.proposalId]) {
            const revision = compactRevision([wire, stamp.packetId || packet.id, stamp.through, stamp.sourceMessageIds]);
            if (state.receipts[stamp.proposalId] !== revision) error('proposal ID reused for a different response');
            if (wire.review?.decision === 'accept') await materialize();
            guard(run);
            return { status: run.memory.wiDiffState.pending ? 'proposed' : 'applied',
                acceptedPacketId: wire.review?.decision === 'accept' ? stamp.reviewedPacketId : null };
        }
        if (stamp.historical && state.backfillPending?.state.receipts?.[stamp.proposalId]) {
            const revision = compactRevision([wire, stamp.packetId || packet.id, stamp.through, stamp.sourceMessageIds]);
            if (state.backfillPending.state.receipts[stamp.proposalId] !== revision) error('proposal ID reused for a different response');
            return { status: 'proposed', acceptedPacketId: null };
        }
        if (stamp.historical || stamp.backfillReview || stamp.rebaseReview) {
            if (state.confirmed.head !== stamp.liveHead || compactRevision(state.pending) !== stamp.livePending
                || backfillRevision(state) !== stamp.backfillRevision)
                error('WI changed after this prefix was prepared; saved response was kept');
        }
        let base = stamp.historical ? stamp.prefixState : stamp.backfillReview ? state.backfillPending?.state : state;
        if (!base) error('saved earlier WI proposal is missing');
        if (stamp.rebaseReview) { base = clone(base); base.pending.baseHead = base.confirmed.head; }
        const previous = base.pending;
        let next = applyWIDiffResponse(base, wire, { ...binding(run), baseHead: stamp.baseHead,
            packetId: stamp.packetId || packet.id, through: stamp.through, proposalId: stamp.proposalId,
            sourceMessageIds: stamp.sourceMessageIds, sources: fresh.sources,
            protectedUIDs: protectedUIDs(book, state.owner),
            allowedUIDs: getWIDiffContext(base, { sources: fresh.sources, cutoff: stamp.through }).records
                .map(record => record.uid).filter(uid => uid !== null) });
        if (stamp.historical) {
            const historicalState = next;
            next = clone(state);
            if (historicalState.pending) next.backfillPending = { state: historicalState };
            // An empty historical response needs no review and changes no live WI.
            else delete next.backfillPending;
        } else if (stamp.backfillReview) {
            const reviewed = next; next = clone(state);
            if (wire.review?.decision === 'accept') {
                const original = new Map(base.confirmed.claims.map(claim => [claim.id, claim]));
                for (const claim of reviewed.confirmed.claims) {
                    const old = original.get(claim.id), live = next.confirmed.claims.find(item => item.id === claim.id);
                    if (!old) { if (live) error('earlier claim ID already exists'); next.confirmed.claims.push(clone(claim)); }
                    else if (claim.retired && !old.retired) {
                        if (!live || live.revision !== old.revision || live.retired) error('earlier removal target changed');
                        live.retired = clone(claim.retired);
                    }
                }
                next.confirmed = createWIDiffState({ ...binding(run), records: [{ claims: next.confirmed.claims }] }).confirmed;
                // Keep the later proposal and its OLD base. Its next explicit
                // review must read the newly confirmed evidence before rebasing.
            }
            next.lastReview = clone(reviewed.lastReview);
            next.receipts[stamp.proposalId] = reviewed.receipts[stamp.proposalId];
            delete next.backfillPending;
        }
        run.memory.wiDiffState = next; await saveState(); guard(run);
        if (wire.review?.decision === 'accept') await materialize(); guard(run);
        return { status: (stamp.historical ? next.backfillPending : next.pending) ? 'proposed' : 'applied',
            acceptedPacketId: previous?.id === wire.review?.proposalId && wire.review?.decision === 'accept' ? previous.packetId : null };
    }

    async function reviewContext() {
        const state = memory()?.wiDiffState, backfillReview = Boolean(state?.backfillPending);
        const pending = backfillReview ? state.backfillPending.state.pending : state?.pending;
        if (!pending) error('nothing awaits review');
        const prepared = await prepare({ sourceIds: Object.keys(pending.sources), packetId: `review:${pending.id}`, reviewOnly: true, backfillReview });
        return { ...prepared, packet: { id: prepared.stamp.packetId, sourceMessageIds: [...prepared.stamp.sourceMessageIds],
            text: '', memoryMetadata: { wiContext: prepared.stamp } } };
    }
    return Object.freeze({ prepare, consume, materialize, reviewContext });
}
