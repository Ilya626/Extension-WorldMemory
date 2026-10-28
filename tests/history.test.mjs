import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, revision, splitHint, activeHint, makeGroups, readHistory, historyNodes, candidates, rank, assemble } from '../history.js';

const countTokens = async text => text.split(/\s+/).filter(Boolean).length;
const source = (index, text, extra = {}) => ({ id: `m${index}`, index, name: index % 2 ? 'GM' : 'Player', isUser: index % 2 === 0, text, ...extra });
const packet = (id, sources, text = 'Saved detailed story') => ({ id, sources, sourceMessageIds: sources.map(s => s.id), text, order: sources[0]?.index || 0 });
const p = packet('p1', [source(0, 'I borrow the brass key.'), source(1, 'Anton lends it until morning; the cabinet stays locked.'), source(4, 'I question Vera.'), source(5, 'Vera only claims she saw a blue car.')]);
const groups = await makeGroups(p, countTokens, 15);
const history = groups.map((g, i) => ({ id: g.id, detail: i ? 'Vera claims she saw a blue car; this remains unverified.' : 'Anton lent the brass key until morning. The cabinet did not open.', compact: i ? 'Vera made an unverified claim.' : 'Borrowed key due by morning; cabinet locked.', keys: i ? ['Vera', 'car'] : ['Anton', 'brass key'] }));
const episodes = readHistory(JSON.stringify({ updates: [], history }), groups);
const stored = { p1: { revision: revision(p), episodes } };

test('service suffix is detached and bound to exact reply; edits invalidate it', () => {
    const result = splitHint('The cabinet stays locked.\n<memory_hint>\nanchor: borrowed key\nkeys: brass; Anton\ncarry: return before morning\n</memory_hint>');
    assert.equal(result.text, 'The cabinet stays locked.');
    const message = { mes: result.text, extra: { worldMemoryHint: result.hint } };
    assert.equal(activeHint(message).carry, 'return before morning');
    message.mes += ' It opens.'; assert.equal(activeHint(message), null);
});
test('missing, malformed or metadata-only replies are not destroyed', () => {
    for (const text of ['Normal RP reply.', 'A reply <memory_hint>not finished', '<memory_hint>anchor: alone</memory_hint>', 'Quoted <memory_hint>not metadata</memory_hint> in prose.']) assert.equal(splitHint(text).text, text);
});
test('groups keep complete exchanges and exact selected IDs, including source gaps', () => {
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(g => g.sources.map(s => s.index)), [[0, 1], [4, 5]]);
    assert.deepEqual(episodes.flatMap(e => e.sourceIds), ['m0', 'm1', 'm4', 'm5']);
});
test('unknown, missing or duplicate group IDs cannot rebind source scope', () => {
    assert.equal(readHistory(JSON.stringify({ history: [history[0]] }), groups), null);
    assert.equal(readHistory(JSON.stringify({ history: [history[0], history[0]] }), groups), null);
    assert.equal(readHistory(JSON.stringify({ history: [history[0], { ...history[1], id: 'other' }] }), groups), null);
});
test('raw hits expand in chronological positions and replace fully covered compact versions', async () => {
    const nodes = historyNodes({ packets: [p] }, stored), docs = candidates(nodes);
    const hits = [docs.find(d => d.kind === 'raw' && d.order === 4), docs.find(d => d.kind === 'raw' && d.order === 0)];
    const result = await assemble(nodes, hits, { baseTokens: 200, zoomTokens: 200, countTokens });
    assert.ok(result.text.indexOf('I borrow') < result.text.indexOf('I question'));
    assert.ok(!result.text.includes('Borrowed key due'));
    assert.ok(!result.text.includes('Vera made an'));
    assert.ok(!result.text.includes('messages 2'));
});
test('partial raw selection preserves selected L0 detail of the remaining sources', async () => {
    const oneGroup = await makeGroups(p, countTokens, 1000);
    const oneEpisode = [{ id: oneGroup[0].id, sourceIds: p.sourceMessageIds, detail: 'DETAIL VERSION', compact: 'SCENE FRAME', keys: [] }];
    const nodes = historyNodes({ packets: [p] }, { p1: { revision: revision(p), episodes: oneEpisode } });
    const docs = candidates(nodes), raw = docs.find(d => d.kind === 'raw' && d.order === 4);
    for (const chosen of [[docs[0], raw], [raw, docs[0]]]) {
        const result = await assemble(nodes, chosen, { baseTokens: 200, zoomTokens: 200, countTokens });
        assert.ok(result.text.includes('DETAIL VERSION')); assert.ok(result.text.includes('I question'));
        assert.equal(result.text.match(/DETAIL VERSION/g).length, 1);
    }
});
test('token budget skips a huge exchange and still permits smaller later hits', async () => {
    const nodes = historyNodes({ packets: [p] }, stored), docs = candidates(nodes);
    const huge = { ...docs.find(d => d.kind === 'raw'), text: 'huge '.repeat(1000) };
    const small = docs.find(d => d.kind === 'raw' && d.order === 4);
    const result = await assemble(nodes, [huge, small], { baseTokens: 200, zoomTokens: 30, countTokens });
    assert.deepEqual(result.selected.map(d => d.id), [small.id]);
    const tooSmall = await assemble(nodes, [], { baseTokens: 1, zoomTokens: 10000, countTokens });
    assert.equal(tooSmall.text, null);
});

test('edits invalidate derived episodes; stale, overlapping or manually hidden sources fall back', () => {
    const changed = structuredClone(p); changed.sources[0].text = 'No key was borrowed.';
    assert.equal(historyNodes({ packets: [changed] }, stored)[0].compact, p.text);
    assert.equal(historyNodes({ packets: [{ ...p, stale: true }] }, stored), null);
    assert.equal(historyNodes({ packets: [p, p] }, stored), null);
    const hidden = structuredClone(p); hidden.sources[0].hidden = true;
    assert.equal(historyNodes({ packets: [hidden] }, stored), null);
    assert.equal(historyNodes({ packets: [] }, stored).length, 0);
});
test('Russian lemmas bridge inflected query and evidence; stale hints never add search claims', () => {
    const docs = [{ id: 'key', order: 0, text: 'Иван стоит у двери' }, { id: 'other', order: 1, text: 'Анна спит' }];
    assert.equal(rank('Иваном', docs, { иваном: ['иван'] })[0].id, 'key');
    const altered = structuredClone(p); altered.sources[0].hint = { fingerprint: hash('another reply'), keys: 'UNSUPPORTED_WORD' };
    const nodes = historyNodes({ packets: [altered] }, stored);
    assert.ok(candidates(nodes).every(doc => !doc.search.includes('UNSUPPORTED_WORD')));
});
