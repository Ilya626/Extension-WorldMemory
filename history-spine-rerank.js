// Optional local second pass. The original candidate pool and source addresses
// stay intact; chronology comes from provenance, never from vector distance.
const GROUP_SIZE = 4;
const overlap = (a, b) => a.start < b.end && a.end > b.start;
function cosine(a, b) {
    if (!a?.length || a.length !== b?.length) return undefined;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    const value = dot / Math.sqrt(aa * bb);
    return Number.isFinite(value) ? value : undefined;
}

/** cells and cellVectors have matching indexes; queries use the same embedding profile. */
export function rerankStoryCandidates(ranked, cells, queryVectors, cellVectors) {
    const bySource = new Map();
    let scoredSteps = 0;
    cells.forEach((cell, index) => {
        if (cell.kind !== 'compact' || !cell.sourceSpans?.length) return;
        const scores = queryVectors.map(query => cosine(query, cellVectors[index])).filter(Number.isFinite);
        if (!scores.length) return;
        const score = Math.max(...scores); scoredSteps++;
        for (const span of cell.sourceSpans) {
            if (!bySource.has(span.sourceId)) bySource.set(span.sourceId, []);
            bySource.get(span.sourceId).push({ span, score });
        }
    });
    const scores = ranked.map(candidate => {
        if (candidate.kind !== 'raw' || candidate.manual) return undefined;
        const evidence = candidate.centerSpans?.length ? candidate.centerSpans : candidate.sourceSpans || [];
        let value;
        for (const span of evidence) for (const step of bySource.get(span.sourceId) || []) {
            if (step.span.sourceRevision !== span.sourceRevision || !overlap(step.span, span)) continue;
            value = value === undefined ? step.score : Math.max(value, step.score);
        }
        return value;
    });
    const order = ranked.map((_, index) => index);
    for (let start = 0; start < order.length; start += GROUP_SIZE) {
        // Candidates without a current outline score keep their exact old slots.
        const slots = order.slice(start, start + GROUP_SIZE).filter(index => Number.isFinite(scores[index]));
        const sorted = slots.slice().sort((a, b) => scores[b] - scores[a] || a - b);
        slots.forEach((slot, i) => { order[slot] = sorted[i]; });
    }
    const output = order.map(index => ranked[index]);
    const diagnostics = { policy: 'bounded scene-semantic rerank; groups of 4; no temporal-distance bonus',
        groupSize: GROUP_SIZE, candidates: ranked.length, scoredSteps,
        scoredCandidates: scores.filter(Number.isFinite).length,
        moved: order.filter((index, position) => index !== position).length,
        maxShift: order.reduce((max, index, position) => Math.max(max, Math.abs(index - position)), 0) };
    output.diagnostics = { ...ranked.diagnostics, spineRerank: diagnostics };
    return { ranked: output, diagnostics };
}
