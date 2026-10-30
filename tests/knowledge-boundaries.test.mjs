import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryTextRevision, metadataSources } from '../vendor/summaryception/memory-metadata.js';
import { readKnowledgeBoundaries, mergeKnowledgeBoundaries, currentKnowledgeBoundaries } from '../knowledge-boundaries.js';
import { buildKnowledgeContext, createKnowledgeRuntime } from '../knowledge-runtime.js';

const world = 'Knowledge fixture', owner = 'fixture-owner';
const book = () => ({ entries: { 0: { uid: 0, comment: 'Anna', key: ['Anna'], content: 'Author-edited character reference.',
    constant: true, disable: false, extensions: { worldMemory: { owner, type: 'character', manual: true, knowledgeInstance: 'fixture-anna' } } } } });
const source = (id, index, text) => ({ id, index, text, name: 'Narrator', hidden: false });
const input = (state, evidence, src = 's1') => ({ who: 'c0', about: 'the safe opener identity', state, evidence, src: [src], time: 'current' });
function packet(id, sources, changes, catalogue) {
    const text = `Complete immutable account ${id}.`;
    const parsed = readKnowledgeBoundaries({ epistemic: changes }, metadataSources(sources), {
        packetId: id, resolveCharacter: catalogue.resolveCharacter });
    assert.deepEqual(parsed.warnings, []);
    return { id, text, sources, sourceMessageIds: sources.map(row => row.id), memoryMetadata: {
        textRevision: memoryTextRevision(text), sourceStatus: 'linked', epistemic: parsed.epistemic } };
}

test('an inexact knowledge quotation creates no state and keeps L0 and other metadata intact', () => {
    const catalogue = buildKnowledgeContext({ book: book(), world, owner });
    const original = source('s0', 0, 'Anna did not know who opened the safe.');
    const saved = { text: 'Complete L0 prose.', metadata: { lprime: { text: 'Safe opened.' }, facts: [{ text: original.text }],
        wi: { updates: [] }, epistemic: [input('knows', 'Anna knew who opened the safe.')] } };
    const before = structuredClone(saved);
    const parsed = readKnowledgeBoundaries(saved.metadata, metadataSources([original]), { resolveCharacter: catalogue.resolveCharacter });
    assert.equal(parsed.epistemic, null);
    assert.ok(parsed.warnings.length > 0);
    assert.deepEqual(saved, before);
    const existing = [{ id: 'manual', manual: true, note: 'Retain the author correction.' }];
    assert.deepEqual(mergeKnowledgeBoundaries(existing, parsed.epistemic), existing);
});

test('a source-message prefix excludes later disclosure and packets crossing the boundary', () => {
    const catalogue = buildKnowledgeContext({ book: book(), world, owner });
    const before = source('before', 0, 'Anna did not know who opened the safe.');
    const after = source('after', 5, 'Anna discovered who opened the safe.');
    const early = packet('early', [before], [input('unaware', before.text)], catalogue);
    const late = packet('late', [after], [input('knows', after.text)], catalogue);
    const options = { activeCharacters: catalogue.knowledge_characters, resolveCharacter: catalogue.resolveCharacter };
    const prefix = currentKnowledgeBoundaries([early, late], { ...options, through: 0 });
    assert.deepEqual(prefix.rows.map(row => row.state), ['unaware']);
    const current = currentKnowledgeBoundaries([early, late], { ...options, through: 5 });
    assert.deepEqual(current.rows.map(row => row.state), ['knows']);
    const crossing = packet('crossing', [before, after], [input('unaware', before.text)], catalogue);
    assert.deepEqual(currentKnowledgeBoundaries([crossing], { ...options, through: 0 }).rows, []);
});

test('receiving a rumor and forming suspicion do not become verified NPC knowledge', () => {
    const catalogue = buildKnowledgeContext({ book: book(), world, owner });
    const heard = source('rumor', 1, 'Anna heard a rumor that Boris had opened the safe.');
    const suspicion = source('suspicion', 2, 'Anna suspected Boris had opened the safe.');
    const packets = [packet('heard', [heard], [input('heard', heard.text)], catalogue),
        packet('suspected', [suspicion], [input('suspects', suspicion.text)], catalogue)];
    const result = currentKnowledgeBoundaries(packets, { activeCharacters: catalogue.knowledge_characters,
        resolveCharacter: catalogue.resolveCharacter });
    assert.deepEqual(result.rows.map(row => row.state).sort(), ['heard', 'suspects']);
    assert.ok(result.rows.every(row => row.state !== 'knows'));
    assert.match(result.text, /heard is receipt, not belief or truth/u);
});

test('editing an original removes its derived native guard and preserves the manual WI book', async () => {
    const nativeBook = book(), beforeBook = structuredClone(nativeBook);
    const catalogue = buildKnowledgeContext({ book: nativeBook, world, owner });
    const original = source('original', 0, 'Anna did not know who opened the safe.');
    const stored = packet('saved', [original], [input('unaware', original.text)], catalogue);
    const context = { chatMetadata: {}, chat: [], eventTypes: {}, eventSource: { on() {}, removeListener() {} } };
    const runtime = createKnowledgeRuntime({ ctx: () => context, settings: () => ({ enabled: true, knowledgeBoundaries: true }),
        getBook: async () => nativeBook, world: () => world, owner: () => owner, snapshot: () => ({ packets: [stored] }) });
    const payload = { chatLore: [{ ...nativeBook.entries[0], world }] }, initialEntry = payload.chatLore[0];
    await runtime.onEntriesLoaded(payload);
    assert.notEqual(payload.chatLore[0], initialEntry);
    assert.match(payload.chatLore[0].content, /Anna: unaware/u);
    assert.equal(payload.chatLore[0].key, initialEntry.key);
    assert.equal(payload.chatLore[0].constant, initialEntry.constant);
    assert.equal(payload.chatLore[0].disable, initialEntry.disable);
    assert.deepEqual(nativeBook, beforeBook);
    original.text = 'The source was edited; its earlier knowledge statement was removed.';
    await runtime.onEntriesLoaded(payload);
    assert.doesNotMatch(payload.chatLore[0].content, /Anna: unaware/u);
    assert.ok(runtime.inspect().warnings.length > 0);
    assert.deepEqual(nativeBook, beforeBook);
    assert.ok(payload.chatLore[0].content.startsWith(beforeBook.entries[0].content));
    runtime.dispose();
});
