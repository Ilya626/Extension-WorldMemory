// One local counting scale for WorldMemory. Never changes ST settings or contacts a provider.
import { contextCalibration } from './context-calibration.js';
const states = new Map();
const PROBE = 'Token counter check. Проверка токенизатора.';
const MAX_CACHE = 512;
const PROMPT_CONCURRENCY = 4;
const FRAMING = 'chat framing: approximate 3/message + 3 reply tokens; text only';
const NATIVE_WARNING = 'Native ST prompt trimming and WI activation use their own counter/cache and may differ.';
const contextOf = context => context || globalThis.SillyTavern?.getContext?.() || {};
const scopeOf = context => JSON.stringify([context.mainApi, context.getTokenizerModel?.(),
    context.powerUserSettings?.tokenizer, context.powerUserSettings?.token_padding]);
const browserLocal = () => typeof location !== 'undefined' && /^https?:$/u.test(location.protocol);

function stateOf(context) {
    const key = scopeOf(context);
    if (!states.has(key)) {
        if (states.size >= 16) states.delete(states.keys().next().value);
        states.set(key, { key, model: context.getTokenizerModel?.() || '', mode: 'pending',
            estimator: 'ST native counter; tokenizer health pending', nativeVerified: false,
            cache: new Map(), inflight: new Map(), pending: null });
    }
    return states.get(key);
}

async function encode(context, model, text) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`/api/tokenizers/openai/encode?model=${encodeURIComponent(model)}`, {
            method: 'POST', headers: { ...context.getRequestHeaders?.(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }), signal: controller.signal,
        });
        if (!response.ok) throw new Error('Local tokenizer endpoint unavailable.');
        const data = await response.json();
        if (!Array.isArray(data.ids) || (text.length && !data.ids.length)) throw new Error('Local tokenizer returned no token IDs.');
        return data.ids.length;
    } finally { clearTimeout(timeout); }
}

function useMode(state, mode, reason = '') {
    if (state.mode !== mode) state.cache.clear();
    state.mode = mode;
    state.nativeVerified = mode === 'native' && state.nativeVerified;
    const nativeName = /claude/iu.test(state.model) ? 'legacy Claude proxy'
        : /gemini|gemma|learnlm/iu.test(state.model) ? 'Gemma proxy for Gemini' : state.model || 'configured';
    state.estimator = mode === 'native' ? `ST local ${nativeName} tokenizer; text IDs verified; provider estimate`
        : mode === 'o200k' ? 'ST local o200k proxy; approximate Gemini/Claude tokens'
            : 'characters/4 emergency approximation; local tokenizers unavailable';
    state.estimator += `; ${FRAMING}`;
    state.warning = [reason, mode === 'native' ? '' : `${state.estimator}.`, NATIVE_WARNING].filter(Boolean).join(' ');
}

/** Probe once per model/settings scope. A broken tokenizer never blocks generation. */
export async function prepareTokenCounter(context, { refresh = false } = {}) {
    const current = contextOf(context), state = stateOf(current);
    // A transient local failure must not disable a saved calibration for the
    // rest of the page session. Retry health once at the next game preparation,
    // not for every text field or during an in-progress scale restart.
    if (refresh && state.mode !== 'native' && state.pending && !contextCalibration(current, tokenCounterKey(current)).active) {
        const pending = state.pending;
        await pending;
        if (state.pending === pending && state.mode !== 'native' && !contextCalibration(current, tokenCounterKey(current)).active) state.pending = null;
    }
    if (state.pending) { await state.pending; return tokenCounterStatus(current); }
    state.pending = (async () => {
        // TC keeps ST's selected counter. Non-browser consumers can supply their own counter.
        if (!browserLocal() || current.mainApi !== 'openai'
            || !/(?:gemini|gemma|learnlm|claude|gpt|^o[134](?:-|$))/iu.test(state.model)) {
            useMode(state, 'native');
            state.estimator = `ST configured text counter; health unverified; provider estimate; ${FRAMING}`;
            return;
        }
        try { await encode(current, state.model, PROBE); state.nativeVerified = true; useMode(state, 'native'); }
        catch {
            try { await encode(current, 'gpt-4o', PROBE); useMode(state, 'o200k', 'Native tokenizer unavailable.'); }
            catch { useMode(state, 'approx', 'Native and o200k tokenizer probes failed.'); }
        }
    })();
    await state.pending;
    return tokenCounterStatus(current);
}

export function tokenCounterStatus(context) {
    const state = stateOf(contextOf(context));
    return { model: state.model, mode: state.mode, estimator: state.estimator,
        warning: state.warning || '', estimated: true, nativeVerified: state.nativeVerified,
        chatFraming: FRAMING, key: `${state.key}:${state.mode}:${state.nativeVerified ? 'verified' : 'configured'}` };
}
export const tokenCounterKey = context => tokenCounterStatus(context).key;

export function contextCounterStatus(context) {
    const current = contextOf(context), base = tokenCounterStatus(current), calibration = contextCalibration(current, base.key);
    const factor = calibration.factor;
    const unavailable = calibration.sample && !calibration.active;
    const warning = unavailable ? 'Saved main-context calibration does not match the local counter. Optional history details are paused until the measured scale recovers or a matching sample is applied.' : '';
    return { ...base, calibration, warning: [base.warning, warning].filter(Boolean).join(' '), proxyEstimator: base.estimator, replyFramingTokens: Math.ceil(3 * factor),
        estimator: calibration.active ? `${base.estimator}; main-context calibration x${factor.toFixed(5)} from ONE provider-input sample; approximate`
            : unavailable ? `${base.estimator}; saved main-context calibration unavailable; optional history details paused` : base.estimator,
        key: calibration.scope ? `${base.key}|${calibration.scope.key}|${factor}` : base.key };
}
export const contextCounterKey = context => contextCounterStatus(context).key;
export const calibratedContextTokens = (tokens, context) => {
    const calibration = contextCounterStatus(context).calibration;
    return calibration.active ? Math.ceil(tokens * calibration.sample.providerInputTokens / calibration.sample.proxyTokens) : Math.ceil(tokens);
};

export async function countContextTextTokens(text, context) {
    return calibratedContextTokens(await countTextTokens(text, context), context);
}
export async function countContextPromptTokens(prompt, context) {
    return calibratedContextTokens(await countPromptTokens(prompt, context), context);
}

async function countUncached(text, current, state) {
    let count, mode = state.mode;
    if (mode === 'native') {
        try {
            // Bypass ST's text-count cache: it can retain an old byte fallback after assets recover.
            count = state.nativeVerified ? await encode(current, state.model, text)
                : await current.getTokenCountAsync?.(text, 0);
            if (!Number.isFinite(count) || count <= 0) throw new Error('Invalid native count.');
        } catch {
            count = undefined;
            if (state.mode !== mode) return countUncached(text, current, state);
            // Native failures can occur after a successful probe. Keep the change visible in the cache key.
            try {
                count = await encode(current, 'gpt-4o', text);
                if (state.mode === mode) useMode(state, 'o200k', 'Native counter failed.');
                mode = 'o200k';
            } catch {
                if (state.mode === mode) useMode(state, 'approx', 'Local counters unavailable.');
                mode = 'approx';
            }
        }
    } else if (mode === 'o200k') {
        try { count = await encode(current, 'gpt-4o', text); }
        catch { useMode(state, 'approx', 'Local o200k counter failed.'); mode = 'approx'; }
    }
    // Another field may have triggered fallback while this request was in flight.
    if (state.mode !== mode) return countUncached(text, current, state);
    count ??= Math.ceil(text.length / 4);
    if (state.cache.size >= MAX_CACHE) state.cache.delete(state.cache.keys().next().value);
    state.cache.set(text, count);
    return count;
}

/** Counts stored/source text, never provider output usage. Cache is memory-only and bounded. */
export async function countTextTokens(value, context) {
    const text = String(value ?? '');
    if (!text.length) return 0;
    const current = contextOf(context);
    await prepareTokenCounter(current);
    const state = stateOf(current);
    if (state.cache.has(text)) return state.cache.get(text);
    if (state.inflight.has(text)) return state.inflight.get(text);
    const pending = countUncached(text, current, state);
    state.inflight.set(text, pending);
    try { return await pending; }
    finally { state.inflight.delete(text); }
}

/** Same tokenizer as retrieval with explicit approximate chat framing, never ST's stale count cache. */
export async function countPromptTokens(prompt, context) {
    const current = contextOf(context);
    await prepareTokenCounter(current);
    if (!Array.isArray(prompt)) return countTextTokens(prompt, current);
    const scale = tokenCounterKey(current);
    // Lazily hand fields to a small worker pool; do not retain a second flattened prompt.
    function* fields() {
        for (const message of prompt) {
            for (const [key, value] of Object.entries(message)) {
                const text = key === 'content' && Array.isArray(value)
                    ? value.filter(part => part.type === 'text').map(part => part.text).join('\n')
                    : typeof value === 'string' ? value : JSON.stringify(value ?? '');
                yield { text, name: key === 'name' ? 1 : 0 };
            }
        }
    }
    const iterator = fields();
    const totals = await Promise.all(Array.from({ length: PROMPT_CONCURRENCY }, async () => {
        let count = 0;
        for (let field = iterator.next(); !field.done; field = iterator.next()) {
            count += await countTextTokens(field.value.text, current) + field.value.name;
        }
        return count;
    }));
    // If a worker caused fallback, recount earlier fields on that same scale.
    if (scale !== tokenCounterKey(current)) return countPromptTokens(prompt, current);
    return 3 + 3 * prompt.length + totals.reduce((sum, count) => sum + count, 0);
}
