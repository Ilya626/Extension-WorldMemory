// Final assembled-chat stage. The existing history, WI, raw tail and settings
// remain intact; only a larger, source-bound history rendering can be committed.
export async function topUpHistory({ prompt, historyText, expand, countPrompt, countText, targetTokens,
    protectedTokens = 0, inputCapacity = Infinity, render = text => text, isCurrent = () => true }) {
    const target = Math.min(Number(targetTokens) + Math.max(0, protectedTokens), inputCapacity);
    if (!Array.isArray(prompt) || !historyText || !Number.isFinite(target) || target <= 0) return { status: 'unavailable' };
    const needle = render(historyText);
    const matches = prompt.filter(message => typeof message.content === 'string' && message.content.includes(needle));
    if (!needle || matches.length !== 1) return { status: 'history-not-found' };
    const message = matches[0], original = message.content;
    const before = await countPrompt(prompt);
    const info = { before, after: before, target, protectedTokens, addedTokens: 0 };
    if (!isCurrent()) return { ...info, status: 'changed' };
    if (before >= target) return { ...info, status: 'full' };
    let historyTarget = await countText(needle) + target - before;
    for (let attempt = 0; attempt < 2; attempt++) {
        const expanded = await expand(historyTarget);
        if (!isCurrent() || message.content !== original) return { ...info, status: 'changed' };
        if (!expanded?.text || expanded.text === historyText) return { ...info, status: 'no-more-details' };
        const replacement = original.replace(needle, () => render(expanded.text));
        const trial = prompt.map(item => item === message ? { ...item, content: replacement } : item);
        const after = await countPrompt(trial);
        if (!isCurrent() || message.content !== original) return { ...info, status: 'changed' };
        if (after <= target && after > before) {
            message.content = replacement;
            return { ...info, after, addedTokens: after - before, historyTarget, expanded, status: 'filled' };
        }
        if (after <= before) return { ...info, status: 'no-more-details' };
        // Account for BPE boundaries around the history wrapper, without
        // truncating a passage or modifying the already assembled baseline.
        historyTarget -= after - target + 2;
    }
    return { ...info, status: 'no-fitting-details' };
}
