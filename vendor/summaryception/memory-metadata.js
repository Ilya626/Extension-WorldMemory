/** Optional companion metadata. Prose memory remains valid when this tail fails. */
export const MEMORY_METADATA_TAG = 'memory_metadata';
export const memoryTextRevision = text => {
    let a = 2166136261, b = 5381;
    for (const char of String(text)) { const n = char.codePointAt(0); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
};

export const MEMORY_METADATA_INSTRUCTION = `Return one <memory_metadata> JSON block that indexes the supplied originals for future retrieval. This is search navigation, not another retelling or a new source of facts.
{"lprime":{"text":"brief ordered scene labels, with unresolved conditions where needed","keys":["specific search phrase"]},"facts":[{"text":"short exact contiguous excerpt from one supplied source","keys":["source-specific search phrase"],"src":["that source handle"]}]}
Keep lprime brief: a few short scene labels in chronological order, separated by semicolons. Name the actors, change or open question; do not explain the whole scene again. Preserve ambiguity instead of assigning a stronger relationship, motive, shared knowledge, cause or outcome. The saved summary is a draft navigation aid; only the supplied originals support this packet.
Cover each supplied source that contains a meaningful action, choice, dialogue, belief, relationship cue or new detail with at least one useful excerpt. Several distinct details in one source may need separate excerpts. A purely empty confirmation or request to continue may be omitted. Do not select only the largest plot events: concrete terms, conditions, small gestures, tone and unresolved obligations can matter later.
For facts.text copy a short continuous passage exactly, including punctuation and enough context to preserve its speaker, condition and meaning. Never paraphrase, join distant passages or insert ellipses. Each excerpt cites exactly one supplied handle. Keep separate excerpts when different sources or different moments matter. Do not repeat the same excerpt.
Use two or three concise, specific keys to make each excerpt searchable by actor, subject and intent. Keys identify what this source is about; they do not settle uncertain consent, motives, diagnoses, possession, promises, deadlines or plans. Distinguish a signal from an opponent's reaction, a proposal from its acceptance, thought from speech and a narrated fact from a character's inference. If a compact label would distort that distinction, omit the label and keep the exact excerpt.
Use only the supplied source handles, never invented IDs or offsets. Lprime and keys follow the requested memory language; exact excerpts keep their original language. If a WI context is supplied, return its separately requested wi.updates in the same block, preserving the history/reference distinction. No prose outside the block.`;

/** Handles are local to this one request. Models never assign durable source IDs. */
export const metadataSources = sources => sources.map((source, index) => ({
    handle: `s${index + 1}`, id: source.id, name: source.name || '', text: source.text,
}));

// Typography-only fallback: each replacement preserves one UTF-16 unit.
// No whitespace, word, quote, minus-sign or general Unicode normalization.
const normalizeExcerptDashes = text => text.replace(/[\u2013\u2014]/g, '-');

function parseMetadataObject(text) {
    try { return JSON.parse(text); }
    catch (error) {
        // A completed object may have redundant trailing closing brackets.
        // Never invent missing values/brackets or repair the object's contents.
        if (!text.trimStart().startsWith('{')) throw error;
        const stack = []; let quoted = false, escaped = false;
        for (let index = 0; index < text.length; index++) {
            const character = text[index];
            if (quoted) {
                if (escaped) escaped = false;
                else if (character === '\\') escaped = true;
                else if (character === '"') quoted = false;
                continue;
            }
            if (character === '"') { quoted = true; continue; }
            if (character === '{' || character === '[') stack.push(character);
            else if (character === '}' || character === ']') {
                if (stack.pop() !== (character === '}' ? '{' : '[')) throw error;
                if (!stack.length) {
                    if (!/^[}\]\s]*$/.test(text.slice(index + 1))) throw error;
                    return JSON.parse(text.slice(0, index + 1));
                }
            }
        }
        throw error;
    }
}

export function readMemoryMetadata(value, sources, { backfill = false, extractiveFacts = false } = {}) {
    const text = String(value || '');
    const start = text.indexOf('<memory_metadata>');
    const prose = (start < 0 ? text : text.slice(0, start)).trim();
    const result = { text: backfill ? null : prose, metadata: null, warning: '' };
    // Stage 2 already expects metadata only; a complete JSON response needs no prose delimiter.
    const bare = backfill && text.trimStart().startsWith('{');
    let body;
    if (bare) body = text.trim();
    else {
        if (start < 0) { result.warning = 'Optional memory metadata was not returned.'; return result; }
        if (text.indexOf('<memory_metadata>', start + 1) >= 0) {
            result.warning = 'Multiple optional metadata tails were ignored; prose was kept.'; return result;
        }
        const match = /^<memory_metadata>\s*([\s\S]*?)\s*<\/memory_metadata>\s*$/.exec(text.slice(start));
        if (!match) { result.warning = 'Optional memory metadata was incomplete; prose was kept.'; return result; }
        body = match[1];
    }
    let data;
    try { data = parseMetadataObject(body); }
    catch { result.warning = 'Optional memory metadata JSON was invalid; prose was kept.'; return result; }
    const strings = values => Array.isArray(values) && values.every(item => typeof item === 'string' && item.trim());
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        result.warning = 'Optional memory metadata was not an object; prose was kept.'; return result;
    }
    const validThread = typeof data.lprime?.text === 'string' && data.lprime.text.trim() && strings(data.lprime.keys);
    const validFacts = Array.isArray(data.facts);
    const validWI = data.wi && typeof data.wi === 'object' && !Array.isArray(data.wi) && Array.isArray(data.wi.updates);
    if (!validThread || !validFacts) result.warning = 'Some optional navigation metadata was incomplete; prose and other valid parts were kept.';
    if (data.wi !== undefined && !validWI) result.warning = 'Optional WI output was invalid; prose and navigation metadata were kept.';
    if (!validThread && !validFacts && !validWI) return result;
    const handles = new Map(sources.map(source => [source.handle, source.id]));
    const sourceByHandle = new Map(sources.map(source => [source.handle, source]));
    const facts = [];
    for (const fact of validFacts ? data.facts : []) {
        if (typeof fact?.text !== 'string' || !fact.text.trim() || !strings(fact.keys)
            || !strings(fact.src) || !fact.src.length || fact.src.some(handle => !handles.has(handle))) {
            result.warning = 'Some optional facts had invalid source links and were ignored.'; continue;
        }
        let text = fact.text.trim();
        let sourceSpans;
        if (extractiveFacts) {
            const source = sourceByHandle.get(fact.src[0]);
            if (fact.src.length !== 1 || typeof source?.text !== 'string') {
                result.warning = 'Some optional search excerpts were not exact source text and were ignored.'; continue;
            }
            let offset = source.text.indexOf(text);
            if (offset < 0) {
                const normalizedSource = normalizeExcerptDashes(source.text), normalizedText = normalizeExcerptDashes(text);
                offset = normalizedSource.indexOf(normalizedText);
                if (offset < 0) {
                    result.warning = 'Some optional search excerpts were not exact source text and were ignored.'; continue;
                }
                if (normalizedSource.lastIndexOf(normalizedText) !== offset) {
                    result.warning = 'Some optional search excerpts had ambiguous dash-normalized source matches and were ignored.'; continue;
                }
                // Keep only the real contiguous original; the model supplies no offsets or durable IDs.
                text = source.text.slice(offset, offset + text.length);
            }
            if (source.text.lastIndexOf(text) === offset) sourceSpans = [{ sourceId: source.id,
                start: offset, end: offset + text.length, offsetUnit: 'utf16', endExclusive: true,
                sourceRevision: memoryTextRevision(source.text) }];
        }
        facts.push({ text, keys: [...new Set(fact.keys)], sourceIds: [...new Set(fact.src.map(handle => handles.get(handle)))],
            ...(sourceSpans ? { sourceSpans } : {}) });
    }
    result.metadata = { version: 1, textRevision: backfill ? null : memoryTextRevision(prose),
        ...(extractiveFacts ? { factMode: 'verbatim-excerpts-v1' } : {}),
        lprime: validThread ? { text: data.lprime.text.trim(), keys: [...new Set(data.lprime.keys)] } : null, facts,
        ...(validWI ? { wi: data.wi } : {}) };
    return result;
}
