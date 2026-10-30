// A bounded view of an unbounded archive. This module never edits saved memory.
import { hash } from './history.js';
import { storySpineCells } from './story-spine.js';

/** Only sources actually present in the snapshot can become original excerpts. */
export function archiveStoryNodes(snapshot) {
    return snapshot.packets.map(packet => ({
        id: packet.id, order: packet.order, orderKnown: packet.orderKnown, sourceIds: packet.sourceMessageIds || [],
        sources: packet.sources || [], stale: Boolean(packet.stale), kind: packet.kind,
        storySpine: packet.storySpine || null,
        detail: packet.text || '', compact: packet.memoryMetadata?.lprime?.text || '',
        facts: Array.isArray(packet.memoryMetadata?.facts) ? packet.memoryMetadata.facts : [],
        keys: packet.memoryMetadata?.lprime?.keys || [],
        summaryOnly: packet.sourceStatus === 'summary-only' || !packet.sources?.length,
        manual: Boolean(packet.manual || packet.kind === 'manual'),
    }));
}
export function archiveHistoryNodes(snapshot) {
    return archiveStoryNodes(snapshot).filter(node => !node.stale).map(node => ({ ...node,
        sources: node.sources.filter(source => !source.hidden) }));
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
export async function selectHistory(nodes, ranked, { targetTokens, countTokens, format = text => text,
    storyNodes = nodes, excludedSourceIds = [], nativeOverlap = false }) {
    const target = Math.max(0, Number(targetTokens) || 0), excluded = new Set(excludedSourceIds);
    const sourceMap = new Map(storyNodes.flatMap(node => node.sources || []).map(source => [source.id, source]));
    const cells = storySpineCells(storyNodes);
    const bySource = new Map();
    for (const cell of cells) for (const span of cell.sourceSpans) {
        if (!bySource.has(span.sourceId)) bySource.set(span.sourceId, []);
        bySource.get(span.sourceId).push({ cell, span });
    }
    const prefix = 'Earlier-story outline: all available steps remain present; gaps and unknown order are marked. Supporting originals follow their matching step as details of the same event. Short outlines are compressed saved accounts, not new evidence: for the same event, originals control exact conditions and attribution. Plans, claims, private thoughts and out-of-character notes retain their status. […] marks omitted source text. '
        + (nativeOverlap ? 'Some archived originals are also visible in the separate chat. Those repeated older messages belong to their original events, not new events after this timeline. Only genuinely later events supersede earlier state.\n'
            : 'The separate recent chat continues this chronology and supersedes older state.\n');
    function mergePassages(passages) {
        const merged = [];
        for (const span of passages.slice().sort((a, b) => sourceMap.get(a.sourceId).index - sourceMap.get(b.sourceId).index
            || a.sourceId.localeCompare(b.sourceId) || a.start - b.start || a.end - b.end)) {
            const last = merged.at(-1);
            if (last?.sourceId === span.sourceId && span.start <= last.end) last.end = Math.max(last.end, span.end);
            else merged.push({ ...span });
        }
        return merged;
    }
    function attachments(passages) {
        const attached = new Map();
        for (const span of passages) {
            const match = (bySource.get(span.sourceId) || []).find(item => item.cell.expandable
                && span.start < item.span.end && span.end > item.span.start);
            if (!match) continue;
            if (!attached.has(match.cell.id)) attached.set(match.cell.id, []);
            attached.get(match.cell.id).push(span);
        }
        return attached;
    }
    function render(passages) {
        const attached = attachments(passages);
        const blocks = [];
        for (const cell of cells) {
            blocks.push({ order: cell.order, start: cell.start, text: cell.kind === 'compact'
                ? `[Story step]\n${cell.text}` : cell.kind === 'compact-summary'
                    ? `[Earlier saved-summary step; original unavailable]\n${cell.text}` : cell.text,
                sourceSpans: [], spineIds: [cell.id], kind: cell.kind });
            for (const span of attached.get(cell.id) || []) {
                const source = sourceMap.get(span.sourceId);
                const last = blocks.at(-1);
                if (last?.kind === 'raw' && last.sourceSpans.at(-1)?.sourceId === span.sourceId
                    && last.sourceSpans.at(-1).end === span.start) {
                    const previous = last.sourceSpans.at(-1);
                    previous.end = span.end;
                    // Preserve the exact union of retrieved windows, not a whole L0 packet.
                    last.text = rawBlock(source, previous);
                    last.spineIds.push(cell.id);
                } else blocks.push({ order: source.index, start: span.start, text: rawBlock(source, span),
                    sourceSpans: [{ ...span }], spineIds: [cell.id], kind: 'raw' });
            }
        }
        return { text: blocks.length ? prefix + blocks.map(block => block.text).join('\n\n') : '', blocks };
    }
    function rawBlock(source, span) {
        const role = source.sourceKind === 'worldbook' ? 'imported worldbook' : source.isUser ? 'player post' : 'narrator post';
        return `[Original message ${source.index}; ${source.name || 'Narrator'}; ${role}; supporting detail for the preceding story step]\n`
            + (span.start ? '[…]\n' : '') + source.text.slice(span.start, span.end)
            + (span.end < source.text.length ? '\n[…]' : '');
    }
    // The complete skeleton is fixed. Retrieval only adds supporting passages.
    let passages = [];
    let result = render(passages), tokens = result.text ? await countTokens(format(result.text)) : 0;
    const baselineTokens = tokens, selected = [], ids = new Set();
    for (const candidate of ranked) {
        if (!target || tokens >= target) break;
        if (ids.has(candidate.id)) continue;
        ids.add(candidate.id);
        const added = [];
        if (candidate.kind === 'raw') for (const span of candidate.sourceSpans || []) {
            const source = sourceMap.get(span.sourceId);
            if (!source || source.hidden || excluded.has(source.id) || span.sourceRevision !== hash(source.text)
                || span.offsetUnit !== 'utf16' || span.endExclusive !== true || !Number.isInteger(span.start)
                || !Number.isInteger(span.end) || span.start < 0 || span.end > source.text.length || span.end <= span.start) continue;
            if ((bySource.get(span.sourceId) || []).some(match => match.cell.expandable
                && span.start < match.span.end && span.end > match.span.start)) added.push(span);
        }
        if (!added.length) continue;
        const next = mergePassages([...passages, ...added]);
        if (JSON.stringify(next) === JSON.stringify(passages)) continue;
        passages = next;
        result = render(passages); tokens = await countTokens(format(result.text)); selected.push(candidate);
    }
    const missing = cells.filter(cell => cell.kind === 'legacy').length, stale = cells.filter(cell => cell.kind === 'stale').length;
    const unknownOrder = cells.filter(cell => cell.orderKnown === false).length;
    const overflowTokens = Math.max(0, tokens - target);
    const warnings = [nativeOverlap ? 'Possible repeats: some archived messages are also left visible in native chat. ST may trim them during assembly; the story baseline is kept to avoid losing their only representation.' : '',
        missing ? `${missing} saved section(s) lack a current compact skeleton; saved accounts or their complete originals were kept. Backfill is explicit.` : '',
        stale ? `${stale} changed-source section(s) are marked unavailable, not reused as current history.` : '',
        unknownOrder ? `${unknownOrder} saved section(s) have unknown original chronology; stable archive order is explicitly labelled.` : '',
        overflowTokens ? `Story skeleton and details use ${tokens} estimated tokens (soft target ${target}); the chronological baseline was not truncated.` : ''];
    return { ...result, selected, tokens, baselineTokens, targetTokens: target, overflowTokens,
        warning: warnings.filter(Boolean).join(' '), reason: result.text ? null : 'No saved story sections. Recent raw chat is separate.',
        spineInfo: { cells: cells.length, expanded: attachments(passages).size, missing, stale, unknownOrder,
            excluded: cells.filter(cell => cell.kind === 'excluded').length,
            summaryOnly: cells.filter(cell => cell.kind === 'compact-summary').length,
            complete: !missing && !stale && !unknownOrder && !cells.some(cell => cell.kind === 'excluded') } };
}
