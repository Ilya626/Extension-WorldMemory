import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const moduleUrl = process.env.WORLD_MEMORY_TEST_SOURCE
    ? pathToFileURL(process.env.WORLD_MEMORY_TEST_SOURCE + '/history.js') : new URL('../history.js', import.meta.url);
const { assemble } = await import(moduleUrl);

test('regression: the user template is counted in History budgets and remains outside provider content', async () => {
    const countTokens = async text => text.split(/\s+/).filter(Boolean).length;
    const nodes = [{ id: 'scene', order: 0, sourceIds: ['m1'], sources: [{ id: 'm1', index: 1 }],
        compact: 'The key is borrowed.', detail: 'The key must return before dawn.', keys: [] }];
    const raw = [{ id: 'raw', node: 'scene', kind: 'raw', order: 0, sourceIds: ['m1'], text: 'return '.repeat(24) }];
    const format = text => 'USER TEMPLATE '.repeat(30) + text + ' END TEMPLATE';
    const plain = await assemble(nodes, raw, { baseTokens: 70, zoomTokens: 60, countTokens });
    assert.ok(plain.text);
    const limited = await assemble(nodes, raw, { baseTokens: 70, zoomTokens: 60, countTokens, format });
    assert.equal(limited.text, null, 'a wrapper that makes the baseline overflow must use ordinary layered memory');
    const wrapped = await assemble(nodes, raw, { baseTokens: 160, zoomTokens: 60, countTokens, format });
    assert.ok(wrapped.text);
    assert.equal(wrapped.tokens, await countTokens(format(wrapped.text)));
    assert.ok(wrapped.tokens <= wrapped.baseline + 60);
    assert.ok(!wrapped.text.includes('USER TEMPLATE'), 'Summaryception applies the wrapper once at injection');
});
