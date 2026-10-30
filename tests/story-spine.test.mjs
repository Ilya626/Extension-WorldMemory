import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../history.js';
import { storySpineSources, readStorySpine, currentStorySpine } from '../story-spine.js';
import { archiveHistoryNodes, archiveStoryNodes, selectHistory } from '../history-selection.js';

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

test('global chronology includes unqueried story sections in source order', async () => {
    const first = source('a', 1, 'The bridge was closed.'), last = source('c', 9, 'The council has not answered.');
    const p1 = packet('early', [first], ['A bridge closed.']), p2 = packet('late', [last], ['A decision remains pending.']);
    const snapshot = { packets: [p2, p1] }, nodes = archiveHistoryNodes(snapshot);
    const result = await selectHistory(nodes, [], { targetTokens: 8000, countTokens, storyNodes: archiveStoryNodes(snapshot) });
    assert.ok(result.text.indexOf('A bridge closed.') < result.text.indexOf('A decision remains pending.'));
    assert.deepEqual(result.blocks.map(b => b.order), [1, 9]);
    assert.equal(result.spineInfo.complete, true);
    assert.equal(result.selected.length, 0);
    assert.equal(currentStorySpine(p1), p1.storySpine);
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
