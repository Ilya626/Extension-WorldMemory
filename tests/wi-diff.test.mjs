import test from 'node:test';import assert from 'node:assert/strict';
import { projectLegacyWI, createWIDiffState, getWIDiffContext, applyWIDiffResponse } from '../wi-diff.js';

function fixture() {
    const sources = { s0: { revision: 'r0', index: 0 }, s1: { revision: 'r1', index: 1 }, s2: { revision: 'r2', index: 2 } };
    const packets = [{ id: 'p0', text: 'Первый L0.', sourceMessageIds: ['s0'], sourceFingerprints: { s0: 'r0' }, sources: [{ id: 's0', index: 0, text: 'Первый исходник.' }] },
        { id: 'p2', text: 'Поздний L0.', sourceMessageIds: ['s2'], sourceFingerprints: { s2: 'r2' }, sources: [{ id: 's2', index: 2, text: 'Поздний исходник.' }] }];
    const book = { entries: { 1: { uid: 1, comment: 'Позднее имя', key: ['Поздний псевдоним'], content: 'Поздний текущий профиль.', extensions: { worldMemory: { owner: 'owner', manual: false, contributions: {
        p0: { sourceMessageIds: ['s0'], subjectName: 'Алиса', subjectType: 'character', facts: 'Алиса ждёт ключ.\nАлиса живёт в башне.' },
        p2: { sourceMessageIds: ['s2'], subjectName: 'Позднее имя', subjectType: 'character', facts: 'Поздняя тайна.' }
    } } } }, 2: { uid: 2, content: 'Ручной профиль.', extensions: { worldMemory: { owner: 'owner', manual: true, contributions: {} } } } } };
    const state = createWIDiffState({ owner: 'owner', book: 'book', records: projectLegacyWI(book, packets, { owner: 'owner', cutoff: 0 }) });
    const options = (s, packetId, proposalId, sourceId) => ({ baseHead: s.confirmed.head, packetId, proposalId,
        through: sources[sourceId].index, sourceMessageIds: [sourceId], sources, allowedUIDs: [1], protectedUIDs: [2] });
    const add = { uid: 1, name: 'Алиса', type: 'character', main: false, keys: ['Алиса'], facts: 'Алиса получила ключ.' };
    return { book, packets, sources, state, options, add };
}

test('addressed WI diff retires only the selected claim and retains source history and old views', () => {
    const f = fixture(), before = structuredClone(f.book), original = f.state.confirmed.claims.find(c => c.text.includes('ждёт ключ'));
    const pending = applyWIDiffResponse(f.state, { version: 1, review: null, add: [f.add], remove: [{ id: original.id, revision: original.revision }] }, f.options(f.state, 'p1', 'proposal1', 's1'));
    const accepted = applyWIDiffResponse(pending, { version: 1, review: { proposalId: 'proposal1', decision: 'accept' }, add: [], remove: [] }, f.options(pending, 'p2', 'review2', 's2'));
    const now = getWIDiffContext(accepted, { sources: f.sources }).records[0].facts;
    assert.match(now, /получила ключ/);assert.match(now, /живёт в башне/);assert.doesNotMatch(now, /ждёт ключ/);
    assert.ok(accepted.confirmed.claims.find(c => c.id === original.id).retired);
    assert.deepEqual(accepted.confirmed.claims.find(c => c.id === original.id).retired.sources, { s1: 'r1', s2: 'r2' });
    assert.match(getWIDiffContext(accepted, { sources: f.sources, cutoff: 1 }).records[0].facts, /ждёт ключ/);
    assert.deepEqual(f.book, before);assert.equal(f.state.confirmed.claims.length, 2);
});

test('pending WI stays outside confirmed references and rejection leaves the confirmed base unchanged', () => {
    const f = fixture();
    const pending = applyWIDiffResponse(f.state, { version: 1, review: null, add: [f.add], remove: [] }, f.options(f.state, 'p1', 'proposal1', 's1'));
    assert.deepEqual(getWIDiffContext(pending, { sources: f.sources }).records, getWIDiffContext(f.state, { sources: f.sources }).records);
    const rejected = applyWIDiffResponse(pending, { version: 1, review: { proposalId: 'proposal1', decision: 'reject' }, add: [], remove: [] }, f.options(pending, 'p2', 'review2', 's2'));
    assert.deepEqual(rejected.confirmed, f.state.confirmed);assert.equal(rejected.pending, null);
    assert.throws(() => applyWIDiffResponse(f.state, { version: 1, review: null, add: [{ ...f.add, uid: 2 }], remove: [] }, f.options(f.state, 'p1', 'manual', 's1')), /manual|foreign|unknown/);
});

test('historical WI projection hides future facts and aliases; stale source/base diffs are rejected', () => {
    const f = fixture(), prefix = projectLegacyWI(f.book, f.packets, { owner: 'owner', cutoff: 1 });
    assert.equal(prefix[0].name, 'Алиса');assert.deepEqual(prefix[0].keys, ['Алиса']);assert.doesNotMatch(JSON.stringify(prefix), /Поздн/);
    const wire = { version: 1, review: null, add: [f.add], remove: [] }, options = f.options(f.state, 'p1', 'proposal1', 's1');
    assert.throws(() => applyWIDiffResponse(f.state, wire, { ...options, baseHead: 'changed' }), /base/);
    const pending = applyWIDiffResponse(f.state, wire, options);
    assert.throws(() => applyWIDiffResponse(pending, { version: 1, review: { proposalId: 'proposal1', decision: 'accept' }, add: [], remove: [] }, {
        ...f.options(pending, 'p2', 'review2', 's2'), sources: { ...f.sources, s1: { ...f.sources.s1, revision: 'edited' } }
    }), /source|revision/);
    assert.equal(pending.pending.id, 'proposal1');
});
