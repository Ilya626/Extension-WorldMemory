import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSupportBundle } from '../support-export.js';

function fixture() {
    const state = { book: 'Current', wiSourceBook: 'Current', archive: { records: {
        a: { id: 'a', text: 'Полный L0.', storySpine: { text: 'Скелет.' }, memoryMetadata: { wi: { updates: [] } } }
    }, sources: { source: { text: 'Исходный текст.' } }, responses: { reply: { responseText: 'Полный ответ модели.' } } } };
    return { chatId: 'chat', name1: 'Player', characterId: 0, chat: [{ mes: 'Полный текущий хвост.', is_user: true }],
        chatMetadata: { worldMemory: state }, characters: [{ avatar: 'card.png', data: { name: 'Игра', extensions: { world: 'Author' } } }] };
}

test('support export keeps the complete game in one snapshot without connection keys or model dispatch', async () => {
    const context = fixture(), before = structuredClone(context), books = { Current: { entries: { 1: { key: ['Имя'], content: 'Полный WI.' } } }, Author: { entries: {} } };
    const reads = [];
    const bundle = await collectSupportBundle({ context, version: 'test',
        settings: { worldMemory: { openaiKey: 'PRIVATE_API_KEY', historyMaxTokens: 12000,
            openaiUrl: 'https://user:PRIVATE_PASS@example.org/v1?key=PRIVATE_QUERY',
            nested: { authorization: 'PRIVATE_AUTH', requestHeaders: { custom: 'PRIVATE_HEADER' } } } },
        inspections: { prompts: () => ({ requests: [{ responseText: 'Ответ в трассе.' }] }) },
        readBook: async name => { reads.push(name); return books[name]; }, readCover: async () => ({ dataUrl: 'data:image/png;base64,COVER' }) });
    assert.deepEqual(bundle.chat.messages, context.chat);
    assert.deepEqual(bundle.backup.state, context.chatMetadata.worldMemory);
    assert.equal(bundle.chat.worldMemoryPath, 'backup.state');
    assert.equal(bundle.chat.metadata.worldMemory, undefined);
    assert.deepEqual(bundle.books, books);
    assert.equal(bundle.settings.worldMemory.historyMaxTokens, 12000);
    assert.equal(bundle.settings.worldMemory.openaiUrl, 'https://example.org/v1');
    assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_/);
    assert.deepEqual(reads.sort(), ['Author', 'Current']);
    assert.deepEqual(context, before);
    assert.equal(bundle.errors.length, 0);
    assert.equal(bundle.cover.dataUrl, 'data:image/png;base64,COVER');
    assert.deepEqual(JSON.parse(JSON.stringify(bundle)).backup.state, before.chatMetadata.worldMemory);
});

test('unavailable support sections are reported while chat, memory and other books remain exportable', async () => {
    const context = fixture(), before = structuredClone(context);
    const bundle = await collectSupportBundle({ context, version: 'test', settings: {},
        inspections: { history: () => { throw new Error('History unavailable'); } },
        readBook: async name => { if (name === 'Author') throw new Error('Book missing'); return { entries: {} }; },
        readCover: async () => { throw new Error('Cover unavailable'); } });
    assert.deepEqual(bundle.backup.state, before.chatMetadata.worldMemory);
    assert.deepEqual(bundle.chat.messages, before.chat);
    assert.deepEqual(bundle.backup.book, { entries: {} });
    assert.deepEqual(bundle.errors.map(error => error.section).sort(), ['book:Author', 'cover', 'inspection:history']);
    assert.equal(bundle.sections['book:Current'].available, true);
    assert.equal(bundle.counts.unavailableSections, 3);
    assert.deepEqual(context, before);
});
