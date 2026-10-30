// A bounded view of an unbounded archive. This module never edits saved memory.
import { hash } from './history.js';

function merge(ranges) {
    const result = [];
    for (const span of ranges.slice().sort((a, b) => a.start - b.start)) {
        const last = result.at(-1);
        if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else result.push({ start: span.start, end: span.end });
    }
    return result;
}
function wholeSentences(source, span) {
    const ends = [...source.matchAll(/[.!?…]+[»”"'’)\]]*(?:\s+|$)|\n+/gu)].map(match => match.index + match[0].length);
    const start = [...ends].reverse().find(end => end <= span.start) ?? 0;
    const end = ends.find(end => end >= span.end) ?? source.length;
    return { start, end };
}

/** Only sources actually present in the snapshot can become original excerpts. */
export function archiveHistoryNodes(snapshot) {
    return snapshot.packets.filter(packet => !packet.stale).map(packet => ({
        id: packet.id, order: packet.order, sourceIds: packet.sourceMessageIds || [],
        sources: (packet.sources || []).filter(source => !source.hidden),
        detail: packet.text || '', compact: packet.memoryMetadata?.lprime?.text || '',
        facts: Array.isArray(packet.memoryMetadata?.facts) ? packet.memoryMetadata.facts : [],
        keys: packet.memoryMetadata?.lprime?.keys || [],
        summaryOnly: packet.sourceStatus === 'summary-only' || !packet.sources?.length,
        manual: Boolean(packet.manual || packet.kind === 'manual'),
    }));
}

/** A packet-wide paraphrase cannot be redacted by raw offsets. Suppress it if any witness is unavailable. */
export function historyPacketThreads(nodes) {
    const hidden = new Set(nodes.flatMap(node => (node.sources || []).filter(source => source.hidden).map(source => source.id)));
    return nodes.filter(node => {
        if (node.hidden || node.stale || node.manual || node.summaryOnly || typeof node.compact !== 'string' || !node.compact.trim()
            || !node.sourceIds?.length) return false;
        const sources = new Map((node.sources || []).map(source => [source.id, source]));
        return node.sourceIds.every(id => !hidden.has(id) && !sources.get(id)?.hidden
            && typeof sources.get(id)?.text === 'string' && sources.get(id).text.trim());
    });
}

/** targetTokens excludes the live raw tail, WI and system/card. It is a soft target. */
export async function selectHistory(nodes, ranked, { targetTokens, countTokens, format = text => text }) {
    const target = Math.max(0, Number(targetTokens) || 0);
    const hidden = new Set(nodes.flatMap(node => (node.sources || []).filter(source => source.hidden).map(source => source.id)));
    const sources = new Map(nodes.filter(node => !node.hidden && !node.stale).flatMap(node => node.sources || [])
        .filter(source => !hidden.has(source.id)).map(source => [source.id, source]));
    const prefix = 'Earlier history. Original excerpts preserve what was written, including plans, claims and private thoughts; they do not establish shared knowledge. Later events and the current chat supersede earlier state.\n';
    function render(selected) {
        const bySource = new Map(), summaries = new Map(), blocks = [];
        for (const doc of selected) {
            if (doc.kind === 'raw') for (const span of doc.sourceSpans || []) {
                const source = sources.get(span.sourceId);
                if (!source || span.sourceRevision !== hash(source.text) || span.offsetUnit !== 'utf16'
                    || span.start < 0 || span.end > source.text.length || span.end <= span.start) continue;
                if (!bySource.has(source.id)) bySource.set(source.id, []);
                bySource.get(source.id).push(wholeSentences(source.text, span));
            }
            else if (doc.kind === 'memory' && !summaries.has(doc.id)) summaries.set(doc.id, doc);
        }
        for (const [id, ranges] of bySource) {
            const source = sources.get(id);
            for (const range of merge(ranges)) blocks.push({ order: source.index, start: range.start,
                text: `[Original message ${source.index}; ${source.name || 'Narrator'}]\n${source.text.slice(range.start, range.end)}`,
                sourceSpans: [{ sourceId: id, ...range, offsetUnit: 'utf16', endExclusive: true, sourceRevision: hash(source.text) }] });
        }
        // Lprime is navigation for retrieval. Prompt evidence comes from the
        // selected originals and explicitly labelled manual/legacy memories.
        for (const doc of summaries.values()) blocks.push({ order: doc.order, start: 0,
            text: `[${doc.manual ? 'User-edited memory' : 'Saved summary; original unavailable'}]\n${doc.text}`, sourceSpans: [] });
        blocks.sort((a, b) => a.order - b.order || a.start - b.start);
        return { text: blocks.length ? prefix + blocks.map(block => block.text).join('\n\n') : '', blocks };
    }
    let result = render([]), tokens = 0;
    const selected = [], ids = new Set();
    for (const candidate of ranked) {
        if (!target || tokens >= target) break;
        if (ids.has(candidate.id)) continue;
        ids.add(candidate.id);
        const trial = render([...selected, candidate]);
        if (!trial.text || trial.text === result.text) continue;
        selected.push(candidate); result = trial;
        tokens = await countTokens(format(result.text));
    }
    return { ...result, selected, tokens, targetTokens: target, overflowTokens: Math.max(0, tokens - target),
        warning: tokens > target ? `Recovered history uses ${tokens} tokens (soft target ${target}). Complete source sentences were kept.` : '',
        reason: result.text ? null : 'No matching archived sources selected. The archive is unchanged.' };
}
