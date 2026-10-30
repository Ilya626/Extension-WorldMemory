/** Extracted unchanged from Summaryception token-memory.js. AGPL-3.0; see LICENSE. */

export function providerUsage(data) {
    const candidates = [
        ['usage.completion_tokens', data?.usage?.completion_tokens],
        ['usage.output_tokens', data?.usage?.output_tokens],
        ['usageMetadata.candidatesTokenCount', data?.usageMetadata?.candidatesTokenCount],
        ['eval_count', data?.eval_count],
    ];
    const found = candidates.find(([, count]) => Number.isFinite(count) && count >= 0);
    return found ? { tokenCount: found[1], tokenCountSource: found[0], usage: structuredClone(data.usage ?? data.usageMetadata ?? { eval_count: data.eval_count }) } : {};
}
