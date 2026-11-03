import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResult } from '../memory.js';
import { readMemoryMetadata } from '../vendor/summaryception/memory-metadata.js';
import { createArchive, readArchive } from '../archive-store.js';
import { installArchiveRuntime } from '../archive-runtime.js';

const update = { uid: null, name: 'Смотритель', type: 'character', main: false, keys: ['Смотритель'],
    facts: 'Смотритель хранит ключ от башни.', content: 'Смотритель хранит ключ от башни.' };
const metadata = { wi: { updates: [update] }, lprime: 'Смотритель хранит ключ.', facts: [] };

test('WI and stage-2 JSON decode presentation wrappers without changing escaped strings', () => {
    const item = { ...update, facts: 'Он сказал: "Жди {три минуты}".\nПуть: C:\\tower.', content: 'Он сказал: "Жди {три минуты}".\nПуть: C:\\tower.' };
    const data = { ...metadata, wi: { updates: [item] } };
    for (const reply of [JSON.stringify(data), '```json\n'+JSON.stringify(data)+'\n```',
        '<memory_metadata>\n```json\n'+JSON.stringify(data)+'\n```\n</memory_metadata>',
        '```json\n<memory_metadata>'+JSON.stringify(data)+'</memory_metadata>\n```']) {
        const parsed = readMemoryMetadata(reply, [], { backfill: true });
        assert.equal(parsed.warning, '');
        assert.deepEqual(parsed.metadata.wi.updates, [item]);
        assert.equal(parseResult(reply)[0].facts, item.facts);
    }
});

function fixture() {
    const archive = createArchive(); let calls = 0, response = JSON.stringify(metadata);
    const context = { chatId: 'parser-regression', chatMetadata: {}, name1: 'Player', chat: [
        {name:'Player',is_user:true,mes:'Кто хранит ключ от башни?'},
        {name:'Смотритель',is_user:false,mes:'Смотритель хранит ключ от башни.'}], getTokenCountAsync: async t => t.length/4 };
    const settings = { enabled: true, auto: true, summarizerWorldInfo: false, retainedContextTokens: 0,
        blindZoneExchanges: 0, ghostUserMessages: false, ghostAssistantMessages: false };
    globalThis.SillyTavern = { getContext: () => context };
    const runtime = installArchiveRuntime({ ctx: () => context, settings: () => settings, getArchive: () => archive,
        saveArchive: async () => {}, prepareReferences: async () => ({ context: {}, stamp: null }),
        sendRequest: async (_settings, system) => { calls++;
            return { text: system.includes('This is stage 1')
                ? 'Смотритель хранит ключ от башни.\n<story_spine>{"text":"Ключ у смотрителя."}</story_spine>' : response }; } });
    return {archive, runtime, setResponse: text => {response=text;}, calls: () => calls};
}

test('a broken neighboring section retains complete WI and the raw reply for request-free replay', async () => {
    const f = fixture();
    const broken = '<memory_metadata>'+JSON.stringify(metadata).slice(0,-1)+',"awareness":[{"evidence":"unfinished';
    f.setResponse(broken); await f.runtime.summarizeNow();
    let record = readArchive(f.archive)[0];
    assert.deepEqual(record.memoryMetadata.wi, metadata.wi);
    assert.match(record.annotationError, /JSON/);
    assert.equal(record.annotationResponse.text, broken);
    const calls = f.calls(), prose = record.text;
    await f.runtime.backfillMemoryMetadata({force:true,savedResponsesOnly:true});
    record = readArchive(f.archive)[0];
    assert.equal(f.calls(), calls);
    assert.deepEqual(record.memoryMetadata.wi, metadata.wi);
    assert.equal(record.text, prose);
});

test('an incomplete WI value is never completed or substituted over the previous saved data', async () => {
    const f = fixture(); await f.runtime.summarizeNow();
    const original = readArchive(f.archive)[0], before = structuredClone(original.memoryMetadata);
    f.setResponse('<memory_metadata>{"wi":{"updates":[{"uid":null,"name":"unfinished');
    await assert.rejects(f.runtime.backfillMemoryMetadata({force:true}), /JSON/);
    let record = readArchive(f.archive)[0];
    assert.deepEqual(record.memoryMetadata, before);
    assert.equal(record.text, original.text);
    assert.match(record.annotationResponse.text, /unfinished/);
    const calls = f.calls();
    const retried = await f.runtime.backfillMemoryMetadata({force:true,savedResponsesOnly:true});
    assert.equal(retried.failed, 1);
    record = readArchive(f.archive)[0];
    assert.equal(f.calls(), calls);
    assert.deepEqual(record.memoryMetadata, before);
});
