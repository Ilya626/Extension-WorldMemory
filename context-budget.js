// Pure context accounting. No prompt trimming, saved-memory edits or API calls.
const count = (value, fallback = 0) => Number.isFinite(Number(value)) && value !== null && value !== ''
    ? Math.max(0, Math.floor(Number(value))) : fallback;
const measured = value => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));

/** C excludes protected exchanges. R + T is the maximum planned uncompressed raw. */
export function contextPolicy(settings = {}) {
    const policy = {
        promptTargetTokens: Math.max(1, count(settings.promptTargetTokens, 32000)),
        historyMaxTokens: count(settings.historyMaxTokens, 12000),
        retainedContextTokens: count(settings.retainedContextTokens, 8000),
        compressionTriggerTokens: Math.max(1, count(settings.compressionTriggerTokens, 4000)),
        batchContextTokens: Math.max(1, count(settings.batchContextTokens, 24000)),
        blindZoneExchanges: count(settings.blindZoneExchanges, 1),
        contextReserveTokens: count(settings.contextReserveTokens, 4000),
        wiActivationTokens: count(settings.wiActivationTokens, 4000),
        wiActivationUnlimited: Boolean(settings.wiActivationUnlimited),
    };
    policy.rawMaximumTokens = policy.retainedContextTokens + policy.compressionTriggerTokens;
    return policy;
}

/** Planning recommendations, never a claim about the size of the player's card. */
export function recommendContextBudget(target = 32000, { fixedTokens, historyBaselineTokens = 0 } = {}) {
    const C = Math.max(1, count(target, 32000));
    const fixed = measured(fixedTokens) ? count(fixedTokens) : 4000;
    const R = Math.floor(C / 4), T = Math.max(1, Math.floor(C / 8)), W = Math.floor(C / 8);
    const history = Math.max(count(historyBaselineTokens), C - fixed - R - T - W, 0);
    const plannedTokens = history + R + T + W + fixed;
    return {
        promptTargetTokens: C, historyMaxTokens: history, retainedContextTokens: R,
        compressionTriggerTokens: T, batchContextTokens: 24000, blindZoneExchanges: 1,
        contextReserveTokens: fixed, wiActivationTokens: W, wiActivationUnlimited: false,
        rawMaximumTokens: R + T, plannedTokens,
        freeTokens: Math.max(0, C - plannedTokens), overflowTokens: Math.max(0, plannedTokens - C),
        fixedSource: measured(fixedTokens) ? 'native-fixed' : 'planning-reserve',
    };
}

/**
 * nativePrompt.fixedTokens may be supplied directly. Alternatively its tokens,
 * rawTokens, historyTokens, wiTokens and protectedTokens must ALL describe the
 * same assembled prompt; only their fixed residual is reused. A previous full
 * prompt total must never replace fresh raw/history counts after a promotion.
 */
export function contextStatistics({ settings = {}, rawPlan = {}, history = {}, protectedTokens,
    wiTokens, fixedTokens, nativePrompt = null } = {}) {
    const policy = contextPolicy(settings), warnings = [];
    let fixed = measured(fixedTokens) ? count(fixedTokens) : null;
    let fixedSource = fixed === null ? 'planning-reserve' : 'measured-fixed';
    if (measured(nativePrompt?.fixedTokens)) {
        fixed = count(nativePrompt.fixedTokens); fixedSource = 'native-fixed';
    } else if (['tokens', 'rawTokens', 'historyTokens', 'wiTokens', 'protectedTokens']
        .every(key => measured(nativePrompt?.[key]))) {
        const components = ['rawTokens', 'historyTokens', 'wiTokens', 'protectedTokens']
            .reduce((sum, key) => sum + count(nativePrompt[key]), 0);
        if (count(nativePrompt.tokens) >= components) {
            fixed = count(nativePrompt.tokens) - components; fixedSource = 'native-fixed-residual';
        }
    }
    const fixedEstimate = fixed ?? policy.contextReserveTokens;
    if (fixed === null) warnings.push('Card/system/hints size is unavailable; accounting uses a planning reserve.');
    const baseline = measured(history.baselineTokens) ? count(history.baselineTokens) : null;
    const historyActual = measured(history.tokens) ? count(history.tokens) : null;
    const historyEstimate = Math.max(historyActual ?? policy.historyMaxTokens, baseline ?? 0);
    const historyDetails = historyActual !== null && baseline !== null ? Math.max(0, historyActual - baseline) : null;
    const retained = count(rawPlan.retainedTokens), available = count(rawPlan.availableTokens);
    const rawTokens = retained + available;
    const wiActual = measured(wiTokens) ? count(wiTokens) : null;
    const wiEstimate = wiActual ?? (policy.wiActivationUnlimited ? 0 : policy.wiActivationTokens);
    const protectedActual = measured(protectedTokens) ? count(protectedTokens) : null;
    if (historyActual === null) warnings.push('History is not measured; accounting reserves its configured budget.');
    if (wiActual === null) warnings.push(policy.wiActivationUnlimited
        ? 'Unlimited World Info is not measured; the total is a lower bound.'
        : 'World Info is not measured; accounting reserves its configured cap.');
    // Fresh raw + fresh history + current WI + reusable fixed overhead. P is outside C.
    const accountedTokens = rawTokens + historyEstimate + wiEstimate + fixedEstimate;
    const overflowTokens = Math.max(0, accountedTokens - policy.promptTargetTokens);
    const historyOverflow = Math.max(0, historyEstimate - policy.historyMaxTokens);
    const plannedTokens = policy.historyMaxTokens + policy.rawMaximumTokens
        + (policy.wiActivationUnlimited ? wiEstimate : policy.wiActivationTokens) + fixedEstimate;
    if (historyOverflow) warnings.push('Complete story outline and whole details exceed the history budget; they remain intact.');
    if (retained > policy.retainedContextTokens) warnings.push('Whole exchanges exceed the retained raw target; messages remain intact.');
    if (plannedTokens > policy.promptTargetTokens) warnings.push('Configured allocations exceed the desired context reference; manual budgets are kept.');
    if (overflowTokens) warnings.push('Accounted context exceeds the desired context; complete story and raw messages are not truncated.');
    return {
        policy,
        history: { budgetTokens: policy.historyMaxTokens, baselineTokens: baseline, detailTokens: historyDetails,
            tokens: historyActual, estimatedTokens: historyEstimate,
            freeTokens: Math.max(0, policy.historyMaxTokens - historyEstimate), overflowTokens: historyOverflow },
        raw: { retainedTokens: retained, availableTokens: available, tokens: rawTokens,
            maximumTokens: policy.rawMaximumTokens, overflowTokens: Math.max(0, rawTokens - policy.rawMaximumTokens) },
        protected: { tokens: protectedActual, exchanges: policy.blindZoneExchanges, outsideBudget: true },
        wi: { tokens: wiActual, estimatedTokens: wiEstimate, unlimited: policy.wiActivationUnlimited,
            capTokens: policy.wiActivationUnlimited ? null : policy.wiActivationTokens,
            overflowTokens: policy.wiActivationUnlimited || wiActual === null ? 0 : Math.max(0, wiActual - policy.wiActivationTokens) },
        fixed: { tokens: fixed, estimatedTokens: fixedEstimate, reserveTokens: policy.contextReserveTokens, source: fixedSource },
        accountedTokens, fullPromptTokens: protectedActual === null ? null : accountedTokens + protectedActual,
        nativeObservedTokens: measured(nativePrompt?.tokens) ? count(nativePrompt.tokens) : null,
        freeTokens: Math.max(0, policy.promptTargetTokens - accountedTokens), overflowTokens,
        plannedTokens, plannedDifferenceTokens: plannedTokens - policy.promptTargetTokens,
        plannedOverflowTokens: Math.max(0, plannedTokens - policy.promptTargetTokens),
        incomplete: historyActual === null || wiActual === null || fixed === null,
        estimated: true, warnings,
    };
}

/** T alone starts compression. C is a recommendation; pressure only informs the player. */
export function summaryDecision({ policy = {}, rawPlan = {}, statistics = null } = {}) {
    const current = contextPolicy(policy);
    const hasBatch = Boolean(rawPlan.hasBatch);
    const triggerReached = count(rawPlan.availableTokens) >= current.compressionTriggerTokens;
    const contextExceeded = measured(statistics?.accountedTokens)
        && count(statistics.accountedTokens) > current.promptTargetTokens;
    const requiresSummary = hasBatch && triggerReached;
    return { hasBatch, requiresSummary, ready: requiresSummary, triggerReached, contextExceeded,
        reason: !hasBatch ? 'no-eligible-batch' : triggerReached ? 'compression-trigger' : 'below-trigger' };
}
