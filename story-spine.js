// Reader chronology only. Retrieval never indexes or requires this structure.
import { hash } from './history.js';

export const STORY_SPINE_INSTRUCTION = `After the complete L0 prose append exactly one <story_spine> JSON block:
{"text":"a short chronological outline of this entire new L0 packet"}
Write one compact outline of the packet as a whole, usually 1–3 sentences (roughly 30–60 words when useful, not a minimum or quota). Keep the main change from the beginning through the ending state, including any prerequisite, withdrawal or unresolved result needed to continue correctly. This is a reader's outline, not a list of source parts or a second detailed summary. Preserve who spoke, planned, knew or claimed something; distinguish proposals from completed results. Out-of-character directions and unplayed scenario material remain such. Do not copy previous_l0 events into this packet's outline. Do not return source handles, IDs, positions, offsets, versions or new facts: code assigns source membership and chronology. Keep the complete L0 prose before this block; no prose after it.`;

/** Freeze code-owned source membership; bounded cells remain readable for legacy outlines. */
export function storySpineSources(sources, options = {}) {
    const { summaryOnly = false, maxCharacters = 1600, wholeSources = false } = typeof options === 'number' ? { maxCharacters: options } : options;
    const output = [], limit = wholeSources ? Infinity : Math.max(256, Math.floor(Number(maxCharacters) || 1600));
    for (const [sourceIndex, source] of (sources || []).entries()) {
        if (typeof source.text !== 'string' || !source.text.trim()) continue;
        const ends = [...source.text.matchAll(/[.!?…]+[»”"'’)\]]*(?:\s+|$)|\n+/gu)].map(m => m.index + m[0].length);
        const sourceRevision = hash(source.text);
        for (let start = 0; start < source.text.length;) {
            let end = Math.min(start + limit, source.text.length);
            if (end < source.text.length) {
                const boundary = ends.findLast(n => n > start + limit / 2 && n <= end);
                if (boundary) end = boundary;
                else {
                    const space = source.text.slice(start, end).search(/\s+\S*$/u);
                    if (space > limit / 2) end = start + space + 1;
                    if (/[\uD800-\uDBFF]/u.test(source.text[end - 1])) end--;
                }
            }
            output.push({ handle: `s${output.length + 1}`, message: `m${sourceIndex + 1}`, id: source.id, name: source.name || '', text: source.text.slice(start, end),
                ...(summaryOnly ? { sourceKind: 'saved-summary', sourceSpans: [], summarySpans: [{ recordId: source.id,
                    textRevision: sourceRevision, start, end, offsetUnit: 'utf16', endExclusive: true }] }
                    : { sourceSpans: [{ sourceId: source.id, start, end, offsetUnit: 'utf16', endExclusive: true, sourceRevision }] }) });
            start = end;
        }
    }
    return output;
}

/** Invalid optional output never consumes or invalidates completed L0 prose. */
export function readStorySpine(value, sources, { backfill = false, savedText = '' } = {}) {
    const response = String(value || ''), start = response.indexOf('<story_spine>');
    const text = backfill ? null : (start < 0 ? response : response.slice(0, start)).trim();
    const result = { text, storySpine: null, warning: '' };
    const match = start < 0 ? null : /^<story_spine>\s*([\s\S]*?)\s*<\/story_spine>\s*$/.exec(response.slice(start));
    let data, formatRepair = null;
    try {
        if (start >= 0 && !match) throw new Error('Incomplete story_spine tail.');
        if (start < 0 && !(backfill && response.trimStart().startsWith('{'))) throw new Error('Story skeleton was not returned.');
        const json = match ? match[1] : response;
        try { data = JSON.parse(json); }
        catch (error) {
            // Observed provider output closed the XML block but omitted only the
            // final JSON string/object closer. Recover its exact text, never a
            // partial XML tail, additional field, or ambiguous unescaped quote.
            const openText = json.replace(/<\/text>\s*$/u, '');
            if (!match || !/^\{\s*"text"\s*:\s*"(?:[^"\\]|\\.)+$/u.test(openText)) throw error;
            data = JSON.parse(`${openText}"}`);
            formatRepair = openText === json ? 'missing-json-closer' : 'xml-text-closer';
            result.warning = 'Story outline JSON closer was missing; its exact text was recovered from the complete story_spine block.';
        }
        if (typeof data?.text === 'string') {
            if (!data.text.trim() || !sources.length) throw new Error('Story outline and its source membership must be nonempty.');
            const sourceSpans = sources.flatMap(source => source.sourceSpans || []);
            const summarySpans = sources.flatMap(source => source.summarySpans || []);
            const node = { id: `spine:${hash(JSON.stringify([sourceSpans, summarySpans]))}`, text: data.text.trim(),
                sourceIds: [...new Set(sourceSpans.map(span => span.sourceId))], sourceSpans,
                ...(summarySpans.length ? { sourceKind: 'saved-summary', summarySpans } : {}) };
            result.storySpine = { version: 2, textRevision: hash(backfill ? savedText : text),
                generationBasis: backfill ? 'saved-l0' : 'same-call', ...(formatRepair ? { formatRepair } : {}), nodes: [node] };
            return result;
        }
        if (!Array.isArray(data?.nodes) || !data.nodes.length || data.nodes.length > sources.length)
            throw new Error('Story skeleton must cover every supplied source handle.');
        const merge = parts => {
            if (!parts.length) return [];
            const span = { ...parts[0] };
            for (const part of parts.slice(1)) {
                if (part.sourceId !== span.sourceId || part.recordId !== span.recordId
                    || part.sourceRevision !== span.sourceRevision || part.textRevision !== span.textRevision || part.start !== span.end)
                    throw new Error('Grouped story handles must address consecutive parts of one source.');
                span.end = part.end;
            }
            return [span];
        };
        let cursor = 0;
        const nodes = data.nodes.map(node => {
            if (typeof node?.text !== 'string' || !node.text.trim() || !Array.isArray(node.src)
                || node.src.length < 1 || node.src.length > 4
                || node.src.some((handle, offset) => handle !== sources[cursor + offset]?.handle))
                throw new Error('Story skeleton has invalid or out-of-order source handles.');
            const group = sources.slice(cursor, cursor + node.src.length), source = group[0];
            if (group.some(part => part.id !== source.id || part.sourceKind !== source.sourceKind
                || !(part.sourceSpans?.length || part.summarySpans?.length)))
                throw new Error('A story node cannot group different messages.');
            cursor += group.length;
            const sourceSpans = merge(group.flatMap(part => part.sourceSpans || []));
            const summarySpans = merge(group.flatMap(part => part.summarySpans || []));
            return { id: `spine:${hash(JSON.stringify([sourceSpans, summarySpans]))}`, text: node.text.trim(),
                sourceIds: [...new Set(sourceSpans.map(span => span.sourceId))], sourceSpans,
                ...(summarySpans.length ? { sourceKind: 'saved-summary', summarySpans } : {}) };
        });
        if (cursor !== sources.length) throw new Error('Story skeleton must cover every supplied source handle.');
        result.storySpine = { version: 1, textRevision: hash(backfill ? savedText : text), nodes };
    } catch (error) { result.warning = error.message || 'Invalid optional story skeleton; L0 was kept.'; }
    return result;
}

export function currentStorySpine(packet) {
    const spine = packet.storySpine;
    if (packet.stale || !spine || ![1, 2].includes(spine.version) || spine.textRevision !== hash(packet.detail ?? packet.text ?? '')
        || !Array.isArray(spine.nodes) || !spine.nodes.length) return null;
    if (spine.nodes.every(node => node.sourceKind === 'saved-summary')) {
        const text = packet.detail ?? packet.text ?? '';
        let end = 0;
        for (const node of spine.nodes) {
            if (!node.text?.trim() || node.sourceSpans?.length || node.sourceIds?.length || node.summarySpans?.length !== 1) return null;
            const span = node.summarySpans[0];
            if (span.recordId !== packet.id || span.textRevision !== hash(text) || span.offsetUnit !== 'utf16'
                || span.endExclusive !== true || span.start !== end || !Number.isInteger(span.end)
                || span.end <= span.start || span.end > text.length) return null;
            end = span.end;
        }
        return end === text.length ? spine : null;
    }
    const sources = new Map((packet.sources || []).map(source => [source.id, source]));
    const membership = new Set(packet.sourceIds || packet.sourceMessageIds || sources.keys()), ranges = new Map();
    let previousOrder = -Infinity, previousEnd = 0;
    for (const node of spine.nodes) {
        if (typeof node.text !== 'string' || !node.text.trim() || !node.sourceSpans?.length) return null;
        for (const span of node.sourceSpans) {
            const source = sources.get(span.sourceId), order = source?.index;
            if (!source || !membership.has(span.sourceId) || span.sourceRevision !== hash(source.text)
                || span.offsetUnit !== 'utf16' || span.endExclusive !== true || !Number.isInteger(span.start)
                || !Number.isInteger(span.end) || span.start < 0 || span.end > source.text.length || span.end <= span.start
                || !Number.isFinite(order) || order < previousOrder || (order === previousOrder && span.start !== previousEnd)) return null;
            if (!ranges.has(source.id)) ranges.set(source.id, []);
            ranges.get(source.id).push(span);
            previousOrder = order; previousEnd = span.end;
        }
    }
    // No missing remainder of an original can hide behind an apparently complete compact account.
    for (const id of membership) {
        const source = sources.get(id), spans = ranges.get(id);
        if (!source || (source.text.trim() && (!spans?.length || spans[0].start !== 0 || spans.at(-1).end !== source.text.length))) return null;
    }
    return spine;
}

/** Every saved section has a position, including explicit unavailable/legacy/manual sections. */
export function storySpineCells(packets) {
    const cells = [], hidden = new Set(packets.flatMap(p => (p.sources || []).filter(s => s.hidden).map(s => s.id)));
    for (const [packetPosition, packet] of packets.entries()) {
        const sources = packet.sources || [], sourceMap = new Map(sources.map(source => [source.id, source]));
        const sourceIds = packet.sourceIds || packet.sourceMessageIds || sources.map(source => source.id);
        const order = Number.isFinite(packet.order) ? packet.order : sources[0]?.index ?? Number.MAX_SAFE_INTEGER;
        const manual = Boolean(packet.manual || packet.kind === 'manual');
        const spine = !manual && currentStorySpine(packet);
        // A packet outline can contain facts from every member. If one member is
        // hidden, retain the other originals explicitly instead of leaking the outline.
        if (!manual && sourceIds.some(id => hidden.has(id))) {
            cells.push({ id: `visibility:${packet.id}`, packetId: packet.id, order, packetPosition, start: -1,
                text: '[Story outline unavailable: manual source visibility excludes part of this packet. Visible originals follow; compact backfill is incomplete.]',
                sourceSpans: [], kind: 'excluded', expandable: false });
            for (const source of sources.filter(source => !hidden.has(source.id) && source.text?.trim())) {
                cells.push({ id: `visible:${packet.id}:${source.id}`, packetId: packet.id, order: source.index,
                    packetPosition, start: 0, text: `[Visible original; packet outline withheld]\n${source.name || 'Narrator'}: ${source.text}`,
                    sourceSpans: [], kind: 'legacy', expandable: false });
            }
            continue;
        }
        if (spine) {
            for (const node of spine.nodes) {
                if (node.sourceKind === 'saved-summary') {
                    cells.push({ id: `${packet.id}:${node.id}`, packetId: packet.id, order, packetPosition,
                        start: node.summarySpans[0].start, text: node.text, sourceSpans: [], kind: 'compact-summary', expandable: false });
                    continue;
                }
                const excluded = node.sourceSpans.some(span => hidden.has(span.sourceId));
                const first = node.sourceSpans[0];
                cells.push({ id: `${packet.id}:${node.id}`, packetId: packet.id, packetPosition, order: sourceMap.get(first.sourceId).index,
                    start: first.start, text: excluded ? '[Section excluded by manual source visibility.]' : node.text,
                    sourceSpans: excluded ? [] : node.sourceSpans, kind: excluded ? 'excluded' : 'compact', expandable: !excluded });
            }
            continue;
        }
        const excluded = !manual && sourceIds.some(id => hidden.has(id));
        const stale = Boolean(packet.stale);
        const kind = manual ? 'manual' : stale ? 'stale' : excluded ? 'excluded' : 'legacy';
        const text = manual ? packet.detail ?? packet.text ?? ''
            : stale ? '[Story section unavailable: original sources changed; rebuild saved memory.]'
            : excluded ? '[Section excluded by manual source visibility.]' : packet.detail ?? packet.text ?? '';
        const label = kind === 'manual' ? `User-edited memory${stale ? '; linked originals changed' : ''}` : kind === 'legacy'
            ? 'Saved account; compact story skeleton unavailable; backfill needed' : 'Story coverage gap';
        const complete = sourceIds.length && sourceIds.every(id => sourceMap.has(id));
        cells.push({ id: `section:${packet.id}`, packetId: packet.id, order, packetPosition, start: 0,
            text: `[${label}]\n${text}`, kind, expandable: kind === 'legacy' && Boolean(complete),
            sourceSpans: kind === 'legacy' && complete ? sourceIds.map(id => {
                const source = sourceMap.get(id);
                return { sourceId: id, start: 0, end: source.text.length, offsetUnit: 'utf16', endExclusive: true, sourceRevision: hash(source.text) };
            }).filter(span => span.end > 0) : [] });
    }
    for (const cell of cells) if (packets[cell.packetPosition]?.orderKnown === false) {
        cell.text = `[Original chronology unavailable; stable saved order]\n${cell.text}`;
        cell.orderKnown = false;
    }
    return cells.sort((a, b) => a.order - b.order || a.packetPosition - b.packetPosition || a.start - b.start || a.id.localeCompare(b.id));
}
