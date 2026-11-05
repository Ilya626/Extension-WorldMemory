import { collectPassage, pendingSourceIds, sourceId } from './summary-sources.js';
import { getModelOutputIssue } from './output-validation.js';
import { summaryDecision } from '../../context-budget.js';
import { countTextTokens, calibratedContextTokens, prepareTokenCounter, contextCounterKey, contextCounterStatus as tokenCounterStatus } from '../../token-counter.js';

const positive = (value, fallback) => Math.max(1, Math.floor(Number(value) || fallback));

/** One exchange starts with user messages and includes their following assistant replies. */
export function chatExchanges(chat) {
    const groups = [];
    let current = null;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (message.is_system && !message.extra?.sc_context && !message.extra?.sc_ghosted) continue;
        if (!current || (message.is_user && current.hasAssistant)) {
            current = { indices: [], hasAssistant: false };
            groups.push(current);
        }
        current.indices.push(i);
        if (!message.is_user && !getModelOutputIssue(message.mes, message)) current.hasAssistant = true;
    }
    return groups;
}

export function blindZoneStart(chat, settings) {
    const groups = chatExchanges(chat);
    const completed = groups.filter(group => group.hasAssistant);
    const count = Math.max(0, Math.floor(Number(settings.blindZoneExchanges) || 0));
    // Unanswered trailing user messages are never pulled into a previous exchange.
    const trailingStart = groups.length && !groups.at(-1).hasAssistant ? groups.at(-1).indices[0] : chat.length;
    return count && completed.length ? completed[Math.max(0, completed.length - count)].indices[0] : trailingStart;
}

async function measure(text, ctx) {
    const count = await countTextTokens(text, ctx);
    return { tokens: Math.max(1, Number(count) || 1),
        contextTokens: Math.max(1, calibratedContextTokens(count, ctx)),
        estimated: true, estimator: tokenCounterStatus(ctx).estimator };
}

/** Blind exchanges are removed before tokenization, retention and batching. */
export async function planRawContext(chat, store, settings, stopped = () => false) {
    if (stopped()) return { ready: false, hasBatch: false, batchCount: 0 };
    const counterContext = SillyTavern.getContext();
    await prepareTokenCounter(counterContext);
    const counterKey = contextCounterKey(counterContext);
    const covered = pendingSourceIds(store);
    const groups = chatExchanges(chat).filter(group => group.hasAssistant);
    const blindStart = blindZoneStart(chat, settings);
    const eligible = [];
    for (const group of groups) {
        if (stopped()) return { ready: false, hasBatch: false, batchCount: 0 };
        if (group.indices[0] >= blindStart) continue;
        const indices = group.indices.filter(index => !chat[index].is_system && !covered.has(sourceId(chat[index])));
        const passage = collectPassage(chat, indices);
        if (!passage.indices.some(index => !chat[index].is_user)) continue;
        const measured = await measure(passage.text, counterContext);
        if (stopped()) return { ready: false, hasBatch: false, batchCount: 0 };
        // A late tokenizer fallback invalidates ALL earlier group counts, not
        // just this group. Archive callers need the same stable-plan guarantee.
        if (contextCounterKey(counterContext) !== counterKey) return planRawContext(chat, store, settings, stopped);
        eligible.push({ ...passage, tokens: measured.tokens, contextTokens: measured.contextTokens, estimated: measured.estimated });
    }
    const retained = Number(settings.retainedContextTokens ?? 12000);
    const retainedBudget = Number.isFinite(retained) ? Math.max(0, Math.floor(retained)) : 12000;
    const batchBudget = positive(settings.batchContextTokens, 24000);
    const triggerBudget = positive(settings.compressionTriggerTokens, batchBudget);
    let boundary = eligible.length;
    let retainedTokens = 0, retainedProxyTokens = 0;
    // Calibration must not shorten the mandatory tail that the same manual R
    // already retained. Keep that native floor as well as the context allowance.
    while (boundary > 0 && (retainedTokens < retainedBudget || retainedProxyTokens < retainedBudget)) {
        const group = eligible[--boundary]; retainedTokens += group.contextTokens; retainedProxyTokens += group.tokens;
    }
    const available = eligible.slice(0, boundary);
    const availableTokens = available.reduce((sum, group) => sum + group.contextTokens, 0);
    // R/T use the main-context scale. Summary API batching keeps the original
    // local counts and its independent manual batchContextTokens allowance.
    const batch = [];
    let batchTokens = 0;
    for (const group of available) {
        if (batch.length && batchTokens + group.tokens > batchBudget) break;
        batch.push(group);
        batchTokens += group.tokens;
        if (batchTokens >= batchBudget) break;
    }
    const passage = collectPassage(chat, batch.flatMap(group => group.indices));
    let batchCount = 0;
    let currentTokens = 0;
    for (const group of available) {
        if (currentTokens && currentTokens + group.tokens > batchBudget) { batchCount++; currentTokens = 0; }
        currentTokens += group.tokens;
        if (currentTokens >= batchBudget) { batchCount++; currentTokens = 0; }
    }
    if (currentTokens) batchCount++;
    return { passage, batchTokens, availableTokens, retainedTokens, batchBudget, retainedBudget,
        batchCount,
        ready: summaryDecision({ policy: { ...settings, compressionTriggerTokens: triggerBudget },
            rawPlan: { availableTokens, hasBatch: batch.length > 0 } }).ready,
        triggerBudget, hasBatch: batch.length > 0,
        availableMessageIds: available.flatMap(group => group.sourceMessageIds),
        blindStart, blindExchanges: groups.filter(group => group.indices[0] >= blindStart).length,
        estimated: eligible.some(group => group.estimated) };
}
