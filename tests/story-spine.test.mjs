import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../history.js';
import { storySpineSources, readStorySpine, currentStorySpine } from '../story-spine.js';
import { archiveHistoryNodes, archiveStoryNodes, selectHistory } from '../history-selection.js';
import { createArchive, putPacket, archiveSnapshot } from '../archive-store.js';
import { installHistory } from '../history-runtime.js';

const countTokens = async text => text.split(/\s+/u).filter(Boolean).length;
const source = (id, index, text) => ({ id, index, name: 'Narrator', isUser: false, text });
function packet(id, sources, descriptions, options = {}) {
    const text = `Saved account ${id}.`, handles = storySpineSources(sources, options);
    const result = readStorySpine(`${text}\n<story_spine>${JSON.stringify({ nodes: handles.map((s, i) => ({
        text: descriptions?.[i] || `Chronological step ${i + 1}.`, src: [s.handle] })) })}</story_spine>`, handles);
    return { id, sources, sourceMessageIds: sources.map(s => s.id), text, order: sources[0]?.index ?? 0,
        storySpine: result.storySpine, sourceStatus: 'linked' };
}
const hit = (packet, source, start = 0, end = source.text.length) => ({ id: `hit:${source.id}:${start}-${end}`,
    kind: 'raw', node: packet.id, sourceIds: [source.id], sourceSpans: [{ sourceId: source.id, start, end,
        offsetUnit: 'utf16', endExclusive: true, sourceRevision: hash(source.text) }] });

test('global chronology includes unqueried story sections in source order', async t => {
    const first = source('a', 1, 'The bridge was closed.'), last = source('c', 9, 'The council has not answered.');
    const p1 = packet('early', [first], ['A bridge closed.']), p2 = packet('late', [last], ['A decision remains pending.']);
    const snapshot = { packets: [p2, p1] }, nodes = archiveHistoryNodes(snapshot);
    const result = await selectHistory(nodes, [], { targetTokens: 8000, countTokens, storyNodes: archiveStoryNodes(snapshot) });
    assert.ok(result.text.indexOf('A bridge closed.') < result.text.indexOf('A decision remains pending.'));
    assert.deepEqual(result.blocks.map(b => b.order), [1, 9]);
    assert.equal(result.spineInfo.complete, true);
    assert.equal(result.selected.length, 0);
    assert.equal(currentStorySpine(p1), p1.storySpine);
    // The reader baseline remains available when the independent search times out.
    const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
    const events = { MESSAGE_RECEIVED: 'reply', GENERATION_ENDED: 'end', CHAT_COMPLETION_PROMPT_READY: 'cc',
        GENERATE_BEFORE_COMBINE_PROMPTS: 'tc', GENERATE_AFTER_DATA: 'data' };
    const context = { chatId: 'fixture', chatMetadata: {}, chat: [{ is_user: true, mes: 'What about the bridge?' }],
        extensionSettings: {}, eventTypes: events, event_types: events, eventSource: { on() {}, makeFirst() {} },
        getTokenCountAsync: countTokens, setExtensionPrompt() {} };
    globalThis.document = { getElementById: () => null };
    globalThis.fetch = async (_url, options) => new Promise((_, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const runtime = installHistory({ ctx: () => context, settings: () => ({ enabled: true, injectionPosition: 0,
            historySemantic: true, historyMaxTokens: 8000, historyEmbeddingAPI: { url: 'https://example.invalid', key: 'fixture' } }),
            bridge: () => ({ snapshot: () => ({ ...snapshot, chatId: context.chatId, chat: context.chat }) }) });
        const preparing = runtime.prepare(context.chat, 24000, null, 'normal');
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(runtime.inspect().text.includes('A bridge closed.'));
        t.mock.timers.tick(120000);
        await preparing;
        assert.ok(runtime.inspect().text.includes('A decision remains pending.'));
        assert.match(runtime.inspect().warning, /baseline kept/u);
    } finally {
        t.mock.timers.reset(); globalThis.document = previousDocument; globalThis.fetch = previousFetch;
    }
});

test('a partial raw hit expands its bounded cell in place and retains other cells', async () => {
    const original = source('long', 3, ('A messenger waits for the conditional reply. ').repeat(24));
    const p = packet('scene', [original], undefined, { maxCharacters: 256 });
    const handles = storySpineSources([original], { maxCharacters: 256 }), middle = Math.floor(handles.length / 2);
    const chosen = handles[middle].sourceSpans[0];
    const result = await selectHistory(archiveHistoryNodes({ packets: [p] }), [hit(p, original, chosen.start + 2, chosen.start + 8)],
        { targetTokens: 8000, countTokens });
    assert.equal(result.spineInfo.expanded, 1);
    assert.ok(!result.text.includes(`Chronological step ${middle + 1}.`));
    assert.ok(result.text.includes(`Chronological step ${middle}.`));
    assert.ok(result.text.includes(`Chronological step ${middle + 2}.`));
    const raw = result.blocks.find(b => b.kind === 'raw');
    assert.deepEqual(raw.sourceSpans, [chosen]);
    assert.ok(raw.text.includes(handles[middle].text));
    assert.equal(result.blocks.length, handles.length);
    // Adjoining technical parts may share a step; a partial hit restores that
    // whole merged range, while the following compact steps stay in place.
    const grouped = [handles.slice(0, 2), ...handles.slice(2).map(handle => [handle])];
    p.storySpine = readStorySpine(`${p.text}\n<story_spine>${JSON.stringify({ nodes: grouped.map((parts, i) => ({
        text: `Grouped step ${i}.`, src: parts.map(part => part.handle) })) })}</story_spine>`, handles).storySpine;
    assert.equal(currentStorySpine(p), p.storySpine);
    const mergedSpan = { ...handles[0].sourceSpans[0], end: handles[1].sourceSpans[0].end };
    const expanded = await selectHistory(archiveHistoryNodes({ packets: [p] }),
        [hit(p, original, handles[1].sourceSpans[0].start + 2, handles[1].sourceSpans[0].start + 8)],
        { targetTokens: 8000, countTokens });
    assert.deepEqual(expanded.blocks.find(b => b.kind === 'raw').sourceSpans, [mergedSpan]);
    assert.ok(expanded.text.includes(original.text.slice(mergedSpan.start, mergedSpan.end)));
    assert.ok(expanded.text.includes('Grouped step 1.'));
    assert.ok(!expanded.text.includes('Grouped step 0.'));
    const differentMessages = storySpineSources([source('x', 1, 'A condition.'), source('y', 2, 'A later answer.')]);
    const invalid = readStorySpine(`${p.text}\n<story_spine>{"nodes":[{"text":"Mixed messages","src":["s1","s2"]}]}</story_spine>`, differentMessages);
    assert.equal(invalid.storySpine, null);
    assert.equal(invalid.text, p.text);
});

test('legacy and manual accounts remain whole; summary-only skeleton never becomes original evidence', async () => {
    const original = source('old', 0, 'A complete older source.'), legacy = { id: 'legacy', sources: [original],
        sourceMessageIds: [original.id], text: 'Full saved older account, including its final condition.', order: 0 };
    const manual = { id: 'manual', manual: true, sources: [], sourceMessageIds: [], order: 2,
        text: 'The author corrected the pending condition.' };
    const saved = { id: 'summary', text: 'Earliest surviving summary of the opening.', order: 4, sources: [], sourceMessageIds: [], sourceStatus: 'summary-only' };
    const handles = storySpineSources([{ id: saved.id, text: saved.text }], { summaryOnly: true });
    saved.storySpine = readStorySpine(`<story_spine>${JSON.stringify({ nodes: [{ text: 'The opening survives as a saved account.', src: ['s1'] }] })}</story_spine>`,
        handles, { backfill: true, savedText: saved.text }).storySpine;
    const result = await selectHistory(archiveHistoryNodes({ packets: [legacy, manual, saved] }), [], { targetTokens: 8000, countTokens });
    assert.ok(result.text.includes(legacy.text)); assert.ok(result.text.includes(manual.text));
    assert.ok(result.text.includes('The opening survives as a saved account.'));
    assert.ok(result.text.includes('original unavailable'));
    assert.equal(result.blocks.find(b => b.kind === 'compact-summary').sourceSpans.length, 0);
    assert.equal(result.spineInfo.missing, 1);
    assert.ok(result.warning.includes('Backfill is explicit'));
    assert.equal(result.spineInfo.summaryOnly, 1);
    const archive = createArchive();
    putPacket(archive, { ...saved, id: 'later', storySpine: null, turnRange: [20, 25], order: undefined });
    putPacket(archive, { ...saved, id: 'earlier', storySpine: null, turnRange: [1, 3], order: undefined });
    const restored = archiveSnapshot(archive);
    assert.deepEqual(restored.packets.map(p => p.id), ['earlier', 'later']);
    // Even unknown legacy positions cannot interleave local offsets of different packets.
    const nested = [0, 1].map(i => ({ ...saved, id: `saved-${i}`, order: 0, text: 'Opening. '.repeat(90) }));
    for (const p of nested) {
        const cells = storySpineSources([{ id: p.id, text: p.text }], { summaryOnly: true, maxCharacters: 256 });
        p.storySpine = readStorySpine(`<story_spine>${JSON.stringify({ nodes: cells.map(s => ({ text: p.id, src: [s.handle] })) })}</story_spine>`,
            cells, { backfill: true, savedText: p.text }).storySpine;
    }
    const restoredStory = await selectHistory(archiveHistoryNodes({ packets: nested }), [], { targetTokens: 8000, countTokens });
    assert.ok(restoredStory.text.lastIndexOf('saved-0') < restoredStory.text.indexOf('saved-1'));
});

test('skeleton and in-place details share the soft budget without truncating the baseline', async () => {
    const originals = [source('one', 1, 'A long original account. '.repeat(30)), source('two', 2, 'The answer remains conditional.')];
    const p = packet('budget', originals, ['A proposal was made.', 'Its answer is still pending.']);
    const nodes = archiveHistoryNodes({ packets: [p] });
    const baseline = await selectHistory(nodes, [], { targetTokens: 1, countTokens, format: text => `User wrapper ${text}` });
    assert.ok(baseline.text.includes('A proposal was made.')); assert.ok(baseline.text.includes('Its answer is still pending.'));
    assert.ok(baseline.overflowTokens > 0);
    const result = await selectHistory(nodes, [hit(p, originals[0])], { targetTokens: baseline.tokens + 1, countTokens,
        format: text => `User wrapper ${text}` });
    assert.equal(result.baselineTokens, baseline.tokens);
    assert.equal(result.spineInfo.expanded, 1);
    assert.equal(result.tokens, await countTokens(`User wrapper ${result.text}`));
    assert.ok(result.overflowTokens > 0); assert.ok(result.text.includes('Its answer is still pending.'));
});
