import test from 'node:test';
import assert from 'node:assert/strict';
import { topUpHistory } from '../history-topup.js';

const countText = async text => text.length;
const countPrompt = async messages => messages.reduce((sum, message) => sum + message.content.length, 0);

test('final history top-up uses the remaining assembled budget with protected exchanges outside C', async () => {
    const text = 'H'.repeat(10);
    const prompt = [{ role: 'system', content: text }, { role: 'system', content: 'W'.repeat(15) }, { role: 'user', content: 'R'.repeat(20) }];
    let requested;
    const result = await topUpHistory({ prompt, historyText: text, countText, countPrompt, targetTokens: 100, protectedTokens: 10,
        expand: async target => { requested = target; return { text: text + 'D'.repeat(target - text.length) }; } });
    assert.equal(requested, 75);
    assert.equal(result.status, 'filled');
    assert.equal(result.before, 45);assert.equal(result.after, 110);assert.equal(result.addedTokens, 65);
    assert.ok(prompt[0].content.startsWith(text));
});

test('top-up changes only history and preserves existing raw, WI, roles and manual allocations', async () => {
    const settings = { promptTargetTokens: 80, historyMaxTokens: 10, retainedContextTokens: 24, wiActivationTokens: 40 };
    const originalSettings = structuredClone(settings);
    const raw = { role: 'user', content: 'R'.repeat(10) }, wi = { role: 'system', content: 'W'.repeat(10) };
    const prompt = [{ role: 'assistant', content: 'H'.repeat(20) }, wi, raw];
    const before = structuredClone(prompt);
    const result = await topUpHistory({ prompt, historyText: prompt[0].content, countText, countPrompt, targetTokens: settings.promptTargetTokens,
        expand: async target => ({ text: 'H'.repeat(20) + 'D'.repeat(target - 20) }) });
    assert.equal(result.status, 'filled');assert.equal(result.after, 80);
    assert.equal(prompt[0].role, before[0].role);
    assert.equal(prompt[1], wi);assert.equal(prompt[2], raw);
    assert.deepEqual(prompt.slice(1), before.slice(1));assert.deepEqual(settings, originalSettings);
});

test('an already full or overflowing assembled request is kept whole without an expansion call', async () => {
    const prompt = [{ role: 'system', content: 'H'.repeat(100) }, { role: 'user', content: 'R'.repeat(50) }];
    const before = structuredClone(prompt);let calls = 0;
    const result = await topUpHistory({ prompt, historyText: prompt[0].content, countText, countPrompt, targetTokens: 100,
        expand: async () => { calls++; throw new Error('must not run'); } });
    assert.equal(result.status, 'full');assert.equal(result.after, 150);assert.equal(calls, 0);
    assert.deepEqual(prompt, before);
});
