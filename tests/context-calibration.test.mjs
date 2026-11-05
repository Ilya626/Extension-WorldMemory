import test from 'node:test';
import assert from 'node:assert/strict';
import { contextCalibrationScope, saveContextCalibration } from '../context-calibration.js';
import { countTextTokens, countPromptTokens, countContextTextTokens, countContextPromptTokens,
    prepareTokenCounter, tokenCounterKey, contextCounterStatus } from '../token-counter.js';
import { hash } from '../history.js';
import { storySpineSources, readStorySpine } from '../story-spine.js';
import { archiveHistoryNodes, archiveStoryNodes, selectHistory } from '../history-selection.js';
import { topUpHistory } from '../history-topup.js';
import { planRawContext } from '../vendor/summaryception/raw-context.js';

const context = id => ({ mainApi: 'openai', getTokenizerModel: () => id,
    getChatCompletionModel: settings => settings.custom_model,
    chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'https://first.invalid/v1', custom_model: 'model-a' },
    extensionSettings: { worldMemory: {}, connectionManager: { selectedProfile: 'profile-a' } },
    getTokenCountAsync: async text => text.length });

test('main-context calibration stays within its connection/profile and known actual model', async () => {
    const ctx = context('calibration-isolation-local');
    await prepareTokenCounter(ctx);
    saveContextCalibration(ctx, tokenCounterKey(ctx), 100, 200);
    assert.equal(await countContextTextTokens('abcd', ctx), 8);
    assert.equal(await countTextTokens('abcd', ctx), 4);
    ctx.chatCompletionSettings.custom_url = 'https://second.invalid/v1';
    assert.equal(await countContextTextTokens('abcd', ctx), 4);
    ctx.chatCompletionSettings.custom_url = 'https://first.invalid/v1';
    ctx.extensionSettings.connectionManager.selectedProfile = 'profile-b';
    assert.equal(await countContextTextTokens('abcd', ctx), 4);
    ctx.extensionSettings.connectionManager.selectedProfile = 'profile-a';
    ctx.chatCompletionSettings.custom_model = 'model-b';
    assert.equal(await countContextTextTokens('abcd', ctx), 4);
    ctx.chatCompletionSettings.custom_model = 'model-a';
    assert.equal(await countContextTextTokens('abcd', ctx), 8);
    ctx.getChatCompletionModel = () => null; // Native Website Model is unknown.
    assert.equal(contextCalibrationScope(ctx), null);
    assert.equal(await countContextTextTokens('abcd', ctx), 4);
});

test('calibrated assembly preserves manual limits and mandatory context while changing retrieved details only', async () => {
    const ctx = context('calibration-assembly-local');
    const settings = { promptTargetTokens: 8000, historyMaxTokens: 3000, retainedContextTokens: 150,
        compressionTriggerTokens: 500, batchContextTokens: 5000, blindZoneExchanges: 1, wiActivationTokens: 200 };
    Object.assign(ctx.extensionSettings.worldMemory, settings);
    const savedSettings = structuredClone(settings);
    const source = { id: 'original', index: 0, name: 'Narrator', isUser: false, text: 'Supporting detail. '.repeat(200) };
    const text = 'Saved account.', handles = storySpineSources([source]);
    const spine = readStorySpine(`${text}\n<story_spine>${JSON.stringify({ nodes: handles.map(s => ({ text: 'Required chronology.', src: [s.handle] })) })}</story_spine>`, handles).storySpine;
    const snapshot = { packets: [{ id: 'l0', text, sources: [source], sourceMessageIds: [source.id], storySpine: spine, order: 0 }] };
    const originalArchive = structuredClone(snapshot), nodes = archiveHistoryNodes(snapshot), storyNodes = archiveStoryNodes(snapshot);
    const ranked = Array.from({ length: Math.ceil(source.text.length / 400) }, (_, i) => ({ id: `hit-${i}`, kind: 'raw', node: 'l0',
        sourceSpans: [{ sourceId: source.id, start: i * 400, end: Math.min(source.text.length, (i + 1) * 400),
            sourceRevision: hash(source.text), offsetUnit: 'utf16', endExclusive: true }] }));
    const mandatory = [{ role: 'system', content: 'F'.repeat(200) }, { role: 'user', content: 'R'.repeat(500) },
        { role: 'system', content: 'W'.repeat(200) }, { role: 'assistant', content: 'P'.repeat(100) }];
    const assemble = async () => {
        const options = { storyNodes, countTokens: value => countContextTextTokens(value, ctx), allowOverflow: false };
        const initial = await selectHistory(nodes, ranked, { ...options, targetTokens: settings.historyMaxTokens });
        const prompt = [structuredClone(mandatory[0]), { role: 'user', content: initial.text }, ...structuredClone(mandatory.slice(1))];
        const protectedTokens = await countContextPromptTokens([mandatory.at(-1)], ctx) - contextCounterStatus(ctx).replyFramingTokens;
        const result = await topUpHistory({ prompt, historyText: initial.text, targetTokens: settings.promptTargetTokens, protectedTokens,
            countPrompt: value => countContextPromptTokens(value, ctx), countText: value => countContextTextTokens(value, ctx),
            expand: targetTokens => selectHistory(nodes, ranked, { ...options, targetTokens }) });
        return { prompt, initial, result, rawTokens: await countPromptTokens(prompt, ctx) };
    };
    ctx.chat = Array.from({ length: 6 }, (_, i) => ({ name: i % 2 ? 'Narrator' : 'Player', is_user: i % 2 === 0,
        mes: (i % 2 ? 'A' : 'U').repeat(160), sc_message_id: `message-${i}` }));
    const previous = globalThis.SillyTavern;
    globalThis.SillyTavern = { getContext: () => ctx };
    try {
        const uncalibrated = await assemble(), rawPlan = await planRawContext(ctx.chat, { layers: [] }, settings);
        saveContextCalibration(ctx, tokenCounterKey(ctx), 100, 200);
        const calibrated = await assemble(), adjustedPlan = await planRawContext(ctx.chat, { layers: [] }, settings);
        assert.ok(calibrated.initial.tokens <= settings.historyMaxTokens);
        assert.ok(calibrated.initial.selected.length < uncalibrated.initial.selected.length);
        assert.equal(calibrated.result.status, 'filled');
        assert.ok(calibrated.result.after <= calibrated.result.target);
        assert.ok(calibrated.rawTokens < uncalibrated.rawTokens);
        assert.match(calibrated.prompt[1].content, /Required chronology\./);
        assert.equal(calibrated.initial.spineInfo.complete, true);
        assert.deepEqual(calibrated.prompt.filter((_, i) => i !== 1), uncalibrated.prompt.filter((_, i) => i !== 1));
        assert.deepEqual(adjustedPlan.passage, rawPlan.passage);
        assert.equal(adjustedPlan.batchTokens, rawPlan.batchTokens);
        assert.equal(adjustedPlan.batchBudget, settings.batchContextTokens);
        assert.equal(adjustedPlan.availableTokens, rawPlan.availableTokens * 2);
        assert.deepEqual(Object.fromEntries(Object.keys(settings).map(k => [k,ctx.extensionSettings.worldMemory[k]])), savedSettings);
        assert.deepEqual(settings, savedSettings);
        assert.deepEqual(snapshot, originalArchive);
    } finally { globalThis.SillyTavern = previous; }
});
