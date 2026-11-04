// Decode presentation wrappers without rewriting source strings or inventing
// missing JSON values. All consumers still validate their own schemas.
export function modelJsonBody(value) {
    let text = String(value ?? '').replace(/^\uFEFF/, '').trim();
    for (let pass = 0; pass < 4; pass++) {
        const before = text;
        text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, '').trim();
        text = text.replace(/^<memory_metadata>\s*/, '').replace(/\s*<\/memory_metadata>$/, '').trim();
        if (text === before) break;
    }
    return text;
}

// Find the end of one complete value. Braces and escaped quotes inside strings
// are data; an incomplete object/array/string is never closed by this decoder.
function valueEnd(text, start) {
    const first = text[start], stack = [];
    let quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') { quoted = false; if (first === '"' && !stack.length) return i + 1; }
            continue;
        }
        if (c === '"') quoted = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
            if (!stack.length) return i;
            if (stack.pop() !== (c === '}' ? '{' : '[')) return -1;
            if (!stack.length) return i + 1;
        } else if (!stack.length && (c === ',' || /\s/.test(c))) return i;
    }
    return !quoted && !stack.length && first !== undefined ? text.length : -1;
}

export function parseModelJson(value) {
    const text = modelJsonBody(value);
    try { return JSON.parse(text); }
    catch (error) {
        // Retain the previous decoder's narrowly scoped extra-closing-bracket
        // compatibility. Missing brackets, commas and quotations are not guessed.
        if (text.startsWith('{')) {
            const end = valueEnd(text, 0);
            if (end > 0 && /^[}\]\s]*$/.test(text.slice(end))) {
                try { return JSON.parse(text.slice(0, end)); } catch { /* report the original syntax error */ }
            }
        }
        throw new SyntaxError(`JSON: ${error.message}`);
    }
}

/** Salvage only complete, individually valid top-level metadata sections. */
export function recoverMetadataSections(value) {
    const text = modelJsonBody(value), result = Object.create(null), seen = new Set();
    const allowed = new Set(['wi', 'wiDiff', 'lprime', 'facts', 'awareness', 'epistemic']);
    if (text[0] !== '{') return result;
    const rootEnd = valueEnd(text, 0);
    if (rootEnd > 0 && !/^[}\]\s]*$/.test(text.slice(rootEnd))) return result;
    let i = 1;
    const whitespace = () => { while (/\s/.test(text[i] || '') && i < text.length) i++; };
    while (i < text.length) {
        whitespace(); if (text[i] !== '"') break;
        const keyEnd = valueEnd(text, i); if (keyEnd < 0) break;
        let key; try { key = JSON.parse(text.slice(i, keyEnd)); } catch { break; }
        if (seen.has(key)) return Object.create(null); // ambiguous repeated section
        seen.add(key); i = keyEnd; whitespace(); if (text[i++] !== ':') break;
        whitespace(); const end = valueEnd(text, i); if (end < 0) break;
        try { const data = parseModelJson(text.slice(i, end)); if (allowed.has(key)) result[key] = data; }
        catch { /* a damaged section does not discard complete earlier sections */ }
        i = end; whitespace(); if (text[i++] !== ',') break;
    }
    return result;
}
