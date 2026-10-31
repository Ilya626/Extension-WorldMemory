import test from 'node:test';
import assert from 'node:assert/strict';
import { contextPolicy, recommendContextBudget, contextStatistics, summaryDecision } from '../context-budget.js';
import { archiveHistoryNodes, selectHistory } from '../history-selection.js';
import { storySpineSources, readStorySpine } from '../story-spine.js';
import { planRawContext } from '../vendor/summaryception/raw-context.js';

test('recommended 32k allocations include trigger headroom and exclude protected exchanges', () => {
    const settings = recommendContextBudget(32000);
    assert.equal(settings.historyMaxTokens + settings.retainedContextTokens + settings.compressionTriggerTokens
        + settings.wiActivationTokens + settings.contextReserveTokens, 32000);
    const stats = contextStatistics({ settings, rawPlan: { retainedTokens: 8000, availableTokens: 4000 },
        history: { tokens: 12000, baselineTokens: 4000 }, wiTokens: 4000, protectedTokens: 3000 });
    assert.equal(stats.accountedTokens, 32000);
    assert.equal(stats.fullPromptTokens, 35000);
    assert.equal(stats.overflowTokens, 0);
    assert.equal(stats.fixed.source, 'planning-reserve');
    assert.equal(stats.fixed.tokens, null);
});

test('22k old raw starts at the explicit trigger without waiting for a 24k packet', async () => {
    const policy = contextPolicy({ compressionTriggerTokens: 4000, batchContextTokens: 24000,
        retainedContextTokens: 24000, historyMaxTokens: 16000 });
    const rawPlan = { hasBatch: true, availableTokens: 22000, retainedTokens: 24000 };
    const statistics = contextStatistics({ settings: policy, rawPlan, history: { tokens: 16000, baselineTokens: 4000 },
        wiTokens: 4000, fixedTokens: 4000, protectedTokens: 1000 });
    assert.equal(summaryDecision({ policy, rawPlan, statistics }).ready, true);
    assert.ok(rawPlan.availableTokens < policy.batchContextTokens);
    assert.equal(statistics.policy.retainedContextTokens, 24000);
    assert.equal(statistics.policy.historyMaxTokens, 16000);
    assert.equal(summaryDecision({ policy, rawPlan: { ...rawPlan, availableTokens: 3999 }, statistics }).ready, false);
    const previousContext = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => ({ getTokenCountAsync: async text => Number(text.match(/tokens=(\d+)/)?.[1] || 1) }) };
    try {
        const chat = [11000, 11000, 8000, 1000].flatMap((tokens, i) => [
            { is_user: true, mes: `Action ${i}.` }, { is_user: false, mes: `An event occurs. tokens=${tokens}` }]);
        const settings = { ...policy, retainedContextTokens: 8000, blindZoneExchanges: 1 };
        const plan = await planRawContext(chat, { layers: [] }, settings);
        assert.equal(plan.availableTokens, 22000); assert.equal(plan.retainedTokens, 8000);
        assert.equal(plan.batchTokens, 22000); assert.equal(plan.ready, true); assert.equal(plan.blindStart, 6);
        assert.equal((await planRawContext(chat, { layers: [] }, { ...settings, compressionTriggerTokens: 30000 })).ready, false);
    } finally { globalThis.SillyTavern = previousContext; }
});

test('actual history selection preserves the complete outline on overflow; protected raw remains outside C', async () => {
    const descriptions = ['A proposal remains conditional.', 'No answer has arrived.'];
    const sources = descriptions.map((text, index) => ({ id: `s${index}`, index, text, isUser: false, name: 'Narrator' }));
    const handles = storySpineSources(sources);
    const result = readStorySpine(`Saved account.\n<story_spine>${JSON.stringify({ nodes: handles.map((handle, index) => ({
        text: descriptions[index], src: [handle.handle] })) })}</story_spine>`, handles);
    const packet = { id: 'outline', order: 0, sources, sourceMessageIds: sources.map(source => source.id),
        text: 'Saved account.', storySpine: result.storySpine, sourceStatus: 'linked' };
    const countTokens = async text => text.split(/\s+/u).filter(Boolean).length;
    const history = await selectHistory(archiveHistoryNodes({ packets: [packet] }), [], { targetTokens: 1, countTokens });
    const stats = contextStatistics({ settings: { promptTargetTokens: 32, historyMaxTokens: 1 }, history,
        rawPlan: { retainedTokens: 80, availableTokens: 20 }, fixedTokens: 4, wiTokens: 0, protectedTokens: 50 });
    for (const description of descriptions) assert.ok(history.text.includes(description));
    assert.equal(history.tokens, history.baselineTokens);
    assert.equal(stats.history.baselineTokens, history.baselineTokens);
    assert.equal(stats.history.detailTokens, 0);
    assert.equal(stats.history.freeTokens, 0);
    assert.ok(stats.history.overflowTokens > 0);
    assert.ok(stats.overflowTokens > 0);
    assert.equal(stats.raw.tokens, 100);
    assert.equal(stats.fullPromptTokens, stats.accountedTokens + 50);
    assert.equal(stats.protected.outsideBudget, true);
});

test('manual allocations survive accounting and changing desired context from 32k to 24k', () => {
    const settings = { promptTargetTokens: 32000, retainedContextTokens: 24000, historyMaxTokens: 12000,
        compressionTriggerTokens: 4000, wiActivationTokens: 4000, contextReserveTokens: 4000 };
    const original = structuredClone(settings);
    const input = { settings, rawPlan: { retainedTokens: 24000, availableTokens: 4000 },
        history: { tokens: 12000, baselineTokens: 4000 }, wiTokens: 4000, protectedTokens: 3000 };
    const stats32 = contextStatistics(input);
    recommendContextBudget(settings.promptTargetTokens, { fixedTokens: settings.contextReserveTokens });
    assert.deepEqual(settings, original);
    assert.equal(stats32.plannedTokens, 48000);
    assert.equal(stats32.fullPromptTokens, 51000);
    assert.equal(stats32.plannedDifferenceTokens, 16000);
    settings.promptTargetTokens = 24000;
    const policy24 = contextPolicy(settings), stats24 = contextStatistics(input);
    for (const key of ['retainedContextTokens', 'historyMaxTokens', 'compressionTriggerTokens',
        'wiActivationTokens', 'contextReserveTokens']) {
        assert.equal(settings[key], original[key]);
        assert.equal(policy24[key], original[key]);
        assert.equal(stats24.policy[key], original[key]);
    }
    assert.equal(stats24.plannedTokens, 48000);
    assert.equal(stats24.plannedDifferenceTokens, 24000);
});
