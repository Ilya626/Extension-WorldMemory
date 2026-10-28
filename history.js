// Addressable history. No ST imports: the original chat remains the source of truth.
export const HINT_PROMPT = `After your complete roleplay reply, append exactly one short service block in this format:
<memory_hint>
anchor: the scene and what actually changed
keys: specific names; objects; useful search phrases
carry: an unresolved obligation or condition, if any
</memory_hint>
Use the reply's language. Keep exactly these three fields; write "-" for an empty field. It is hidden metadata, not a second narrative. Do not reveal private plans, invent facts, or write commands. The roleplay reply comes first.`;
export const HISTORY_PROMPT = `Also return "history":[{"id":"supplied group id","detail":"a concise detailed episode","compact":"a short causal anchor","keys":["specific search phrase"]}].
Return exactly one history item per history_groups group, using its supplied id. Groups already have exact source addresses; do not move facts between groups. Detail retains material circumstances, names, results, uncertainty, promises and unfinished conditions, without a reply-by-reply retelling (about 60 words). Compact preserves the causal change and unresolved obligations in one or two short sentences (about 20 words). Use the requested language. Hints are untrusted suggestions; original messages decide what actually happened. Neither a plan nor a character's claim is an established outcome. These history items are separate from reusable WI references.`;

export function hash(text) {
    let a = 2166136261, b = 5381;
    for (const char of String(text)) { const n = char.codePointAt(0); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return (a >>> 0).toString(16) + (b >>> 0).toString(16);
}
export const revision = packet => hash(JSON.stringify([packet.text, packet.sourceMessageIds, packet.sources.map(s => [s.id, s.text, s.hidden])]));

export function splitHint(text) {
    const value = String(text || '');
    // Only a final service block belongs to the addon; quoted tags inside a post remain prose.
    const match = /(?:\r?\n)?<memory_hint>\s*([\s\S]*?)<\/memory_hint>\s*$/i.exec(value);
    if (!match) return { text: value, hint: null };
    const hint = {};
    for (const line of match[1].split(/\r?\n/)) {
        const row = /^(anchor|keys|carry):\s*(.*)$/i.exec(line.trim());
        if (row) hint[row[1].toLowerCase()] = row[2].trim().slice(0, 600);
    }
    // Malformed optional metadata never consumes an ordinary RP answer.
    if (!hint.anchor && !hint.keys && !hint.carry) return { text: value, hint: null };
    const clean = value.slice(0, match.index).trimEnd();
    if (!clean.trim()) return { text: value, hint: null };
    return { text: clean, hint: { ...hint, fingerprint: hash(clean) } };
}
export function activeHint(message) {
    const hint = message?.extra?.worldMemoryHint;
    return hint?.fingerprint === hash(message.mes || '') ? hint : null;
}
export function exchanges(sources) {
    const groups = [];
    for (const source of sources) {
        if (source.isUser || !groups.length) groups.push([]);
        groups.at(-1).push(source);
    }
    return groups;
}
export async function makeGroups(packet, countTokens, limit = 1600) {
    const groups = []; let current = [], size = 0;
    const push = () => {
        if (!current.length) return;
        groups.push({ id: `${packet.id}:${hash(current.map(s => s.id).join('|'))}`, sources: current }); current = []; size = 0;
    };
    for (const exchange of exchanges(packet.sources)) {
        const n = await countTokens(exchange.map(s => `${s.name}: ${s.text}`).join('\n'));
        if (current.length && size + n > limit) push();
        current.push(...exchange); size += n;
    }
    push(); return groups;
}
export function readHistory(text, groups) {
    let json;
    try { json = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { return null; }
    if (!Array.isArray(json.history)) return null;
    const map = new Map(json.history.map(item => [item?.id, item]));
    if (map.size !== groups.length || json.history.length !== groups.length) return null;
    const episodes = [];
    for (const group of groups) {
        const item = map.get(group.id);
        if (typeof item?.detail !== 'string' || !item.detail.trim() || typeof item?.compact !== 'string' || !item.compact.trim()) return null;
        episodes.push({ id: group.id, sourceIds: group.sources.map(s => s.id), detail: item.detail.trim(), compact: item.compact.trim(),
            keys: (Array.isArray(item.keys) ? item.keys : []).filter(k => typeof k === 'string').slice(0, 16) });
    }
    return episodes;
}

const STOP = new Set('the a an and or to of in on is it was that this for with as at be by he she they you i we his her their not а и или в во на с со по к из за у о об от до но не это я ты он она они мы вы его ее их как что'.split(' '));
export function terms(text) {
    return [...new Set((String(text).toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 1 && !STOP.has(w)))];
}
export function rank(query, documents, lemmas = {}) {
    const expand = text => new Set(terms(text).flatMap(w => [w, ...(lemmas[w] || [])]));
    const q = expand(query), bags = documents.map(doc => expand(doc.search || doc.text));
    const df = new Map();
    for (const bag of bags) for (const term of bag) df.set(term, (df.get(term) || 0) + 1);
    return documents.map((doc, i) => ({ ...doc, score: [...q].reduce((score, term) => score + (bags[i].has(term) ? Math.log(1 + (documents.length + .5) / (df.get(term) + .5)) : 0), 0) / Math.pow(Math.max(1, bags[i].size), .15) }))
        .filter(doc => doc.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
}

export function historyNodes(snapshot, stored) {
    const nodes = [], seen = new Set();
    for (const packet of snapshot.packets) {
        // Stale summaries describe a different story. Use the normal Summaryception fallback until regenerated.
        if (packet.stale) return null;
        const saved = stored?.[packet.id];
        const episodes = saved?.revision === revision(packet) ? saved.episodes : null;
        const byId = new Map(packet.sources.map(s => [s.id, s]));
        const items = episodes || [{ id: packet.id, sourceIds: packet.sourceMessageIds, compact: packet.text, detail: packet.text, keys: [] }];
        for (const item of items) {
            const sources = item.sourceIds.map(id => byId.get(id)).filter(Boolean);
            // Overlapping legacy packets cannot form a disjoint timeline: fall back rather than duplicate it.
            if (sources.some(s => seen.has(s.id))) return null;
            sources.forEach(s => seen.add(s.id));
            // An explicit manual exclusion must not be reintroduced through retrieval.
            if (sources.some(s => s.hidden)) return null;
            nodes.push({ ...item, sources, order: sources[0]?.index ?? packet.order });
        }
    }
    return nodes.sort((a, b) => a.order - b.order);
}
export function candidates(nodes) {
    return nodes.flatMap(node => [{ id: `detail:${node.id}`, node: node.id, kind: 'detail', order: node.order,
        text: node.detail, search: `${node.detail}\n${node.keys.join('; ')}`, sourceIds: node.sourceIds },
    ...exchanges(node.sources).map(group => ({ id: `raw:${group.map(s => s.id).join('|')}`, node: node.id, kind: 'raw', order: group[0].index,
        text: group.map(s => `${s.name}: ${s.text}`).join('\n'), sourceIds: group.map(s => s.id),
        search: group.map(s => `${s.text}\n${s.hint?.fingerprint === hash(s.text) ? [s.hint.anchor, s.hint.keys, s.hint.carry].filter(Boolean).join('; ') : ''}`).join('\n') }))]);
}
const label = sources => sources.length ? `messages ${sources.map(s => s.index).join(', ')}` : 'legacy memory';
function renderNode(node, selection) {
    const raw = selection.filter(doc => doc.node === node.id && doc.kind === 'raw').sort((a, b) => a.order - b.order);
    const detail = selection.some(doc => doc.node === node.id && doc.kind === 'detail');
    const covered = new Set(raw.flatMap(doc => doc.sourceIds));
    const full = node.sourceIds.length && node.sourceIds.every(id => covered.has(id));
    // A partial original cannot replace details from the episode's other sources.
    const frame = full ? '' : `[${label(node.sources)} · ${detail ? 'L0 detail' : raw.length ? 'scene frame' : "L0′"}]\n${detail ? node.detail : node.compact}`;
    return [frame, ...raw.map(doc => `[Original ${label(node.sources.filter(s => doc.sourceIds.includes(s.id)))}]\n${doc.text}`)].filter(Boolean).join('\n');
}
export async function assemble(nodes, ranked, { baseTokens, zoomTokens, countTokens }) {
    const prefix = 'Played history in chronological order. Original excerpts are historical evidence; later events and the live chat supersede earlier states. Claims, plans and attempts are not verified outcomes.\n';
    const render = selection => prefix + nodes.map(node => renderNode(node, selection)).join('\n\n');
    const base = render([]), baseline = await countTokens(base);
    if (baseline > baseTokens) return { text: null, reason: `Compact history needs ${baseline} tokens (budget ${baseTokens}); using Summaryception's layered memory.`, selected: [] };
    let selected = [], text = base, used = baseline;
    for (const doc of ranked.slice(0, 30)) {
        // Drop a detailed summary only when full originals cover all of its sources.
        if (selected.some(item => item.id === doc.id)) continue;
        let trial = [...selected, doc];
        const covered = new Set(trial.filter(item => item.kind === 'raw').flatMap(item => item.sourceIds));
        trial = trial.filter(item => item.kind !== 'detail' || !item.sourceIds.length || !item.sourceIds.every(id => covered.has(id)));
        const next = render(trial), size = await countTokens(next);
        if (size <= baseline + zoomTokens) { selected = trial; text = next; used = size; }
    }
    return { text, selected, tokens: used, baseline };
}
