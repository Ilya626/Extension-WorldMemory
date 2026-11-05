import { countPromptTokens, tokenCounterStatus } from './token-counter.js';
import { supportSettings } from './support-export.js';

// Keep one game request in memory. Nothing is written into chat/card metadata.
    // ST emits this event immediately before serializing its backend request. Keep
    // its object until generation ends, so later listeners' message changes
// are included too, even when they replace the messages array.
export function installPromptDiagnostics({ ctx }) {
    let last = null;
    const context = () => typeof ctx === 'function' ? ctx() : ctx;
    const identity = c => JSON.stringify([c.groupId ?? null, c.chatId, c.characters?.[c.characterId]?.avatar ?? null]);
    const sameChat = () => last && identity(context()) === last.identity;
    const freeze = () => {
        if (!last?.pending) return;
        const data = last.pending;
        last.payload = Object.fromEntries(['type', 'model', 'messages', 'chat_completion_source', 'stream', 'max_tokens',
            'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'n', 'reasoning_effort', 'verbosity',
            'tools', 'tool_choice', 'json_schema', 'custom_prompt_post_processing']
            .filter(key => data[key] !== undefined).map(key => [key, structuredClone(data[key])]));
        last.serverProcessing = { customBodyOverrides: Boolean(data.custom_include_body?.trim()),
            observed: false, reason: 'Native frontend event; subsequent server/provider transformations are not observed.' };
        last.pending = null;
    };
    const c = context(), events = c.eventTypes || c.event_types;
    if (events.CHAT_COMPLETION_SETTINGS_READY) c.eventSource.on(events.CHAT_COMPLETION_SETTINGS_READY, data => {
        if (data?.type === 'quiet' || !Array.isArray(data?.messages) || !context().chatId) return;
        const current = context();
        last = { identity: identity(current), capturedAt: new Date().toISOString(), localCaptureId: crypto.randomUUID(),
            chatId: current.chatId, tokenizerModel: current.getTokenizerModel?.(), mainApi: current.mainApi,
            pending: data, reply: null, inFlight: true };
    });
    if (events.MESSAGE_RECEIVED) c.eventSource.on(events.MESSAGE_RECEIVED, (index, type) => {
        if (type !== 'quiet' && type !== 'first_message' && sameChat() && last.inFlight)
            last.reply = context().chat[Number(index)] || null;
    });
    if (events.GENERATION_ENDED) c.eventSource.on(events.GENERATION_ENDED, () => { freeze(); if (last) last.inFlight = false; });

    return { inspect: async () => {
        const unavailable = reason => ({ status: 'unknown', reason, sessionOnly: true,
            usage: { status: 'unknown' }, requestId: { status: 'unknown', value: null }, localEstimate: { status: 'unknown' } });
        if (!sameChat()) return unavailable('No game request observed for this chat in the current page session. Export after its next generation.');
        if (last.pending) return unavailable('Game generation is still in progress. Export after it finishes or stops; the final native request is not frozen yet.');
        const record = last, payload = structuredClone(record.payload), current = context();
        let localEstimate = { status: 'unknown', reason: 'The tokenizer/model changed after this request.' };
        if (record.mainApi === current.mainApi && record.tokenizerModel === current.getTokenizerModel?.()) {
            try {
                localEstimate = { status: 'available', tokens: await countPromptTokens(payload.messages, current),
                    estimated: true, estimator: tokenCounterStatus(current).estimator, scope: 'captured-native-request',
                    providerUsage: false };
            } catch (error) { localEstimate = { status: 'unknown', reason: error.message }; }
        }
        // Stock ST 1.19 does not emit raw response usage/request IDs. Use only
        // explicit native message metadata if the installed ST supplies it;
        // local token_count/total estimate is never substituted for usage.
        const extra = record.reply?.extra || {}, rawUsage = extra.usage ?? extra.usageMetadata ?? extra.provider_usage;
        const hasUsage = rawUsage && ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens',
            'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount']
            .some(key => Number.isFinite(rawUsage[key]));
        const requestId = extra.request_id ?? extra.requestId ?? extra.provider_request_id;
        return { status: 'available', sessionOnly: true, capturedAt: record.capturedAt, localCaptureId: record.localCaptureId,
            chatId: record.chatId, source: 'CHAT_COMPLETION_SETTINGS_READY',
            scope: 'Native frontend request after extension hooks; connection keys/headers omitted.',
            payload, messagesJSONBytes: new TextEncoder().encode(JSON.stringify(payload.messages)).length,
            serverProcessing: record.serverProcessing, localEstimate,
            usage: hasUsage ? { status: 'available', source: 'native reply message extra', data: supportSettings(rawUsage) }
                : { status: 'unknown', reason: 'ST did not expose provider response usage to this addon.' },
            requestId: typeof requestId === 'string' && requestId ? { status: 'available', value: requestId, source: 'native reply message extra' }
                : { status: 'unknown', value: null, reason: 'ST did not expose a provider request ID.' } };
    } };
}
