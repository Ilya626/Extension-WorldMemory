import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSupportImport, rebindCompleteBackup, filterImportedBookEntries } from '../support-import.js';
import { archiveSnapshot, sourceFingerprint } from '../archive-store.js';
import { compactRevision, packetSignature } from '../memory.js';
import { buildKnowledgeContext } from '../knowledge-runtime.js';
import { memoryTextRevision } from '../vendor/summaryception/memory-metadata.js';
import { usesWIDiffs } from '../wi-diff.js';

function exported() {
    const message = { sc_message_id: 'source-1', name: 'Player', is_user: true, mes: 'Original message.' };
    const entry = { uid: 0, key: ['Person'], comment: 'Person', content: 'Original WI.', characterFilter: { names: ['Character', 'Unrelated'], isExclude: false },
        extensions: { worldMemory: { owner: 'old-owner', type: 'character', knowledgeInstance: 'instance-1', contributions: {} } } };
    const book = { entries: { 0: entry } };
    const character = buildKnowledgeContext({ book, world: 'History', owner: 'old-owner' }).resolveCharacter('c0');
    const record = { id: 'packet-1', kind: 'l0', text: 'Original L0.', sourceMessageIds: ['source-1'],
        sourceFingerprints: { 'source-1': sourceFingerprint(message) }, storySpine: { text: 'Original outline.' },
        memoryMetadata: { textRevision: memoryTextRevision('Original L0.'), wi: { updates: [] }, wiContext: { owner: 'old-owner', book: 'History', authorBook: 'History' },
            awareness: [{ actors: [{ who: 'c0', character }], fact: 'Original annotation.' }] } };
    const archive = { version: 1, records: { 'packet-1': record }, sources: {}, legacy: {}, responses: { r1: { responseText: 'Original response.', wiContext: { owner: 'old-owner', book: 'History' } } } };
    const state = { owner: 'old-owner', chatId: 'old-chat', book: 'History', wiSourceBook: 'History', archive,
        packets: {}, history: { cached: true }, wiPackets: {}, wiDiffState: { owner: 'old-owner', branch: 'old-owner', book: 'History',
            confirmed: { head: 'original-head', claims: [] }, pending: { id: 'pending-1', add: [], remove: [] }, receipts: { accepted: 'receipt' } } };
    const packet = archiveSnapshot(archive, { chat: [message] }, { effective: false }).packets[0];
    state.wiPackets[record.id] = { status: 'applied', revision: compactRevision([packetSignature(packet), record.memoryMetadata.wi, record.memoryMetadata.wiContext]) };
    return { format: 'world-memory-support-v1', version: '1', chat: { id: 'old-chat', messages: [message], metadata: { world_info: 'History', summaryception: { layers: [] } } },
        backup: { format: 'world-memory-v1', state, book }, card: { stored: { data: { name: 'Character', description: 'Original persona.', extensions: { world: 'History', unrelated: { value: 42 } } } } },
        books: { History: book }, worldInfo: { bindings: { global: ['History'], chat: 'History', character: 'History', extra: [] } },
        settings: { worldMemory: { openaiUrl: 'https://example.invalid', connectionProfileId: 'old-profile' } }, inspections: { prompts: { requests: [{ responseText: 'Original prompt result.' }] } } };
}

test('complete import preserves chat/archive/diffs and remaps its independent native bindings', () => {
    const bundle = exported(), untouched = structuredClone(bundle);
    const result = prepareSupportImport(bundle, { owner: 'new-owner', chatId: 'new-chat' });
    assert.equal(result.name, 'Character Import_(1)');
    assert.deepEqual(bundle, untouched);
    assert.deepEqual(result.messages, bundle.chat.messages);
    assert.equal(result.card.data.description, bundle.card.stored.data.description);
    assert.deepEqual(result.card.data.extensions.unrelated, { value: 42 });
    assert.equal(result.card.data.extensions.world, 'History Import_(1)');
    const memory = result.metadata.worldMemory, record = memory.archive.records['packet-1'];
    assert.equal(memory.chatId, 'new-chat'); assert.equal(memory.owner, 'new-owner');
    assert.equal(memory.book, 'History Import_(1)'); assert.equal(memory.wiSourceBook, memory.book);
    assert.equal(result.metadata.world_info, memory.book);
    assert.deepEqual(result.books[memory.book].entries[0].characterFilter.names, ['Character Import_(1)', 'Unrelated']);
    assert.equal(record.text, bundle.backup.state.archive.records['packet-1'].text);
    assert.deepEqual(record.storySpine, bundle.backup.state.archive.records['packet-1'].storySpine);
    assert.equal(record.memoryMetadata.wiContext.owner, 'new-owner');
    assert.equal(record.memoryMetadata.wiContext.authorBook, memory.book);
    assert.equal(record.memoryMetadata.awareness[0].actors[0].character.world, memory.book);
    assert.notEqual(record.memoryMetadata.awareness[0].actors[0].character.revision, bundle.backup.state.archive.records['packet-1'].memoryMetadata.awareness[0].actors[0].character.revision);
    assert.equal(memory.archive.responses.r1.responseText, 'Original response.');
    assert.equal(memory.archive.responses.r1.wiContext.book, memory.book);
    assert.deepEqual(memory.wiDiffState.pending, bundle.backup.state.wiDiffState.pending);
    assert.deepEqual(memory.wiDiffState.confirmed, bundle.backup.state.wiDiffState.confirmed);
    assert.equal(memory.wiDiffState.branch, 'new-owner');
    const receivingSettings = { wiDiffs: false, connectionProfileId: 'local-profile' };
    assert.equal(usesWIDiffs(receivingSettings, memory), true);
    assert.deepEqual(receivingSettings, { wiDiffs: false, connectionProfileId: 'local-profile' });
    const packet = archiveSnapshot(memory.archive, { chat: result.messages }, { effective: false }).packets[0];
    assert.equal(memory.wiPackets['packet-1'].status, 'applied');
    assert.equal(memory.wiPackets['packet-1'].revision, compactRevision([packetSignature(packet), packet.memoryMetadata.wi, packet.memoryMetadata.wiContext]));
    assert.deepEqual(result.metadata.worldMemoryImport.settings, bundle.settings);
    assert.deepEqual(result.metadata.worldMemoryImport.inspections, bundle.inspections);
    const wholeBackup = { ...bundle.backup, chat: { messages: bundle.chat.messages,
        character: { name: bundle.card.stored.data.name, avatar: 'Character.png' } } };
    const native = rebindCompleteBackup(wholeBackup, { owner: 'native-owner', chatId: 'native-chat',
        bookName: 'Native book', messages: bundle.chat.messages, avatar: 'Character2.png', characterNames: ['Character'] });
    assert.ok(native);
    assert.equal(native.state.owner, 'native-owner'); assert.equal(native.state.chatId, 'native-chat');
    assert.equal(native.state.wiDiffState.book, 'Native book'); assert.equal(native.state.wiDiffState.branch, 'native-owner');
    assert.deepEqual(native.state.wiDiffState.pending, bundle.backup.state.wiDiffState.pending);
    assert.deepEqual(native.state.history, bundle.backup.state.history);
    assert.equal(native.book.entries[0].extensions.worldMemory.owner, 'native-owner');
    assert.notEqual(native.book.entries[0].extensions.worldMemory.manual, true);
    assert.deepEqual(native.book.entries[0].extensions.worldMemory.contributions, bundle.backup.book.entries[0].extensions.worldMemory.contributions);
    assert.deepEqual(native.book.entries[0].characterFilter.names, ['Character2', 'Unrelated']);
    const nativePacket = archiveSnapshot(native.state.archive, { chat: bundle.chat.messages }, { effective: false }).packets[0];
    assert.equal(native.state.wiPackets['packet-1'].revision,
        compactRevision([packetSignature(nativePacket), nativePacket.memoryMetadata.wi, nativePacket.memoryMetadata.wiContext]));
});

test('repeated import selects one free suffix for character and every book without changing originals', () => {
    const bundle = exported(), before = structuredClone(bundle);
    bundle.books.Other = { entries: {} }; bundle.worldInfo.bindings.extra = ['Other'];
    const one = prepareSupportImport(bundle, { owner: 'owner-1' });
    const two = prepareSupportImport(bundle, { characterNames: [one.name], bookNames: Object.keys(one.books), owner: 'owner-2' });
    assert.equal(two.name, 'Character Import_(2)');
    assert.deepEqual(Object.keys(two.books), ['History Import_(2)', 'Other Import_(2)']);
    assert.deepEqual(two.extraBooks, ['Other Import_(2)']);
    const collision = prepareSupportImport(bundle, { bookNames: ['Other Import_(1)', 'History Import_(2)'] });
    assert.equal(collision.suffix, 'Import_(3)');
    assert.deepEqual(bundle.backup, before.backup); assert.deepEqual(bundle.card, before.card);
    assert.notEqual(one.metadata.worldMemory.owner, two.metadata.worldMemory.owner);
});

test('invalid export fails before publication and leaves original objects and API settings unchanged', () => {
    const bundle = exported(); delete bundle.books.History;
    const before = structuredClone(bundle), api = { connectionProfileId: 'local', openaiUrl: 'https://local.invalid', openaiKey: 'local-secret' };
    const originalAPI = structuredClone(api);
    assert.throws(() => prepareSupportImport(bundle, { characterNames: ['Original'], bookNames: ['History'], settings: api }), /unavailable/);
    assert.deepEqual(bundle, before); assert.deepEqual(api, originalAPI);
    assert.throws(() => prepareSupportImport({ ...exported(), chat: { messages: [{ broken: true }] } }), /complete chat/);
    assert.throws(() => prepareSupportImport({ format: 'another-format' }), /WorldMemory-all/);
});

test('repeated assembly after two imports excludes ancestral books without accumulating entries', () => {
    const bundle = exported(), first = prepareSupportImport(bundle, { owner: 'owner-1' });
    const roundtrip = { ...bundle, card: { stored: first.card }, books: first.books,
        backup: first.backup, chat: { ...bundle.chat, metadata: first.metadata },
        worldInfo: { bindings: { global: [first.metadata.worldMemory.book], chat: first.metadata.worldMemory.book } } };
    const second = prepareSupportImport(roundtrip, { characterNames: [first.name], bookNames: Object.keys(first.books), owner: 'owner-2' });
    const current = second.metadata.worldMemory.book;
    const saved = ['History', first.metadata.worldMemory.book, current, 'Unrelated'].map(world => ({ world, uid: 0, content: 'Saved WI.' }));
    const original = structuredClone(saved);
    for (let assembly = 0; assembly < 2; assembly++) {
        const payload = { globalLore: structuredClone(saved), characterLore: [], chatLore: [], personaLore: [] };
        filterImportedBookEntries(payload, second.metadata.worldMemoryImport);
        filterImportedBookEntries(payload, second.metadata.worldMemoryImport);
        assert.deepEqual(payload.globalLore.map(entry => entry.world), [current, 'Unrelated']);
        assert.equal(payload.globalLore.map(entry => entry.content).join('\n').length, 19);
    }
    assert.deepEqual(saved, original);
});
