/**
 * WorldMemory history injection. Placement adapted from Summaryception index.js
 * (updateInjection/placeMemoryBeforeChat/placeTextMemoryBeforeChat), AGPL-3.0.
 * See vendor/summaryception/LICENSE. The caller supplies selected history only.
 */
const PROMPT_KEY = 'world_memory_history';
const MEMORY_START = '<world_memory_story_memory>';
const MEMORY_END = '</world_memory_story_memory>';

export function installHistoryInjection({ ctx, settings, getText, onPromptSize }) {
    const context = () => typeof ctx === 'function' ? ctx() : ctx;
    const options = () => (typeof settings === 'function' ? settings() : settings) || {};
    let lastInjection = '';
    let promptSourceChat = null;
    let sourceChat = null;

    // ST passes its processed messages before formatting and trimming. Retain
    // that reference without editing it or other interceptors' output.
    function capture(processedChat) {
        promptSourceChat = Array.isArray(processedChat) ? processedChat : null;
        sourceChat = context().chat;
    }

    function refresh() {
        const current = context(), s = options();
        const supplied = s.enabled === false || s.injectionPosition === -1 ? '' : getText();
        let text = typeof supplied === 'string' && supplied.trim()
            ? String(s.injectionTemplate ?? '{{summary}}').replace('{{summary}}', () => supplied) : '';
        const beforeChat = (s.injectionPosition ?? 1) === 0;
        if (beforeChat && text) text = `${MEMORY_START}\n${text}\n${MEMORY_END}`;
        // CC budgets at depth 0 before trimming. TC preallocates the injection
        // before all chat. The ready hooks move the already-budgeted block.
        const position = beforeChat ? 1 : (s.injectionPosition ?? 1);
        const depth = beforeChat ? (current.mainApi === 'openai' ? 0 : 10000) : (s.injectionDepth ?? 12);
        const args = [text, position, depth, s.injectionScan ?? false, s.injectionRole ?? 1];
        const signature = JSON.stringify(args);
        if (signature !== lastInjection) {
            current.setExtensionPrompt(PROMPT_KEY, ...args);
            lastInjection = signature;
        }
        return text;
    }

    async function placeMemoryBeforeChat({ chat }) {
        if (!Array.isArray(chat)) return;
        const sourceIndex = chat.findIndex(message => typeof message.content === 'string' && message.content.includes(MEMORY_START));
        if (sourceIndex < 0) return; // Raw/profile requests have no history injection.
        const { promptManager, setOpenAIMessages } = await import('/scripts/openai.js');
        const nativeMessages = promptManager.messages.flatten().filter(message => message.content || message.tool_calls);
        const current = context();
        const processed = sourceChat === current.chat ? promptSourceChat : null;
        const sources = setOpenAIMessages(processed || current.chat.filter(message => !message.is_system));
        const sourceText = new Set(sources.map(message => `${message.role}\0${current.substituteParams(message.content)}`));
        const textContent = content => typeof content === 'string' ? content : (content || [])
            .filter(part => part.type === 'text').map(part => part.text).join('\n');
        let boundaryOffset = 0;
        const boundary = nativeMessages.find(message => {
            if (!/^(?:chatHistory-|toolCall-chatHistory-|continuePrefill)/.test(message.identifier)) return false;
            const text = textContent(message.content);
            if (sourceText.has(`${message.role}\0${text}`) || message.tool_calls) return true;
            // ST can squash a narrator message with a leading system note.
            if (message.role !== 'system') return false;
            const offsets = sources.filter(source => source.role === 'system' && source.content)
                .map(source => text.indexOf(current.substituteParams(source.content))).filter(offset => offset >= 0);
            if (!offsets.length) return false;
            boundaryOffset = Math.min(...offsets);
            return true;
        }) || nativeMessages.find(message => message.identifier === 'newMainChat');
        let insertionIndex = boundary
            ? chat.findIndex(message => message.role === boundary.role && message.content === boundary.content) : chat.length;
        if (insertionIndex < 0) insertionIndex = chat.length;
        else if (boundary.identifier === 'newMainChat') insertionIndex++;
        const source = chat[sourceIndex];
        const start = source.content.indexOf(MEMORY_START);
        const end = source.content.indexOf(MEMORY_END, start);
        if (end < 0) return;
        const memory = source.content.slice(start + MEMORY_START.length, end).trim();
        const remainder = (source.content.slice(0, start) + source.content.slice(end + MEMORY_END.length)).trim();
        if (remainder) source.content = remainder;
        else {
            chat.splice(sourceIndex, 1);
            if (sourceIndex < insertionIndex) insertionIndex--;
        }
        if (boundaryOffset > 0) {
            const message = chat[insertionIndex];
            const prefix = message.content.slice(0, boundaryOffset).trimEnd();
            message.content = message.content.slice(boundaryOffset).trimStart();
            chat.splice(insertionIndex++, 0, { role: 'system', content: prefix });
        }
        chat.splice(insertionIndex, 0, { role: ['system', 'user', 'assistant'][options().injectionRole ?? 1], content: memory });
    }

    function placeTextMemoryBeforeChat({ finalMesSend }) {
        if (!Array.isArray(finalMesSend)) return;
        const index = finalMesSend.findIndex(message => message.injected && message.message.includes(MEMORY_START));
        if (index < 0) return;
        // Preserve the formatted, budgeted block, including instruct syntax.
        const [memory] = finalMesSend.splice(index, 1);
        memory.message = memory.message.replace(MEMORY_START, '').replace(MEMORY_END, '');
        const boundary = finalMesSend.findIndex(message => !message.injected);
        finalMesSend.splice(boundary < 0 ? finalMesSend.length : boundary, 0, memory);
    }

    async function measurePrompt(data, dryRun) {
        if (!onPromptSize || dryRun) return;
        const prompt = data?.prompt ?? data?.input;
        const format = Array.isArray(prompt) ? 'chat' : typeof prompt === 'string' ? 'text' : null;
        if (!format) return;
        const current = context(), metadata = current.chatMetadata, chat = current.chat;
        const text = format === 'chat' ? JSON.stringify(prompt) : prompt;
        let tokens, estimator = 'characters/4';
        if (typeof current.getTokenCountAsync === 'function') {
            try {
                const count = await current.getTokenCountAsync(text, 0);
                if (Number.isFinite(count) && (count > 0 || !text.length)) {
                    tokens = count;
                    estimator = 'ST tokenizer';
                }
            } catch { /* Informational measurement must not stop generation. */ }
        }
        tokens ??= Math.ceil(text.length / 4);
        if (context().chat !== chat || context().chatMetadata !== metadata) return;
        await onPromptSize({ tokens, estimated: true, estimator, format,
            scope: 'assembled-input', serializedChat: format === 'chat',
            excludes: ['response tokens', 'provider-side prompt changes', 'native multimodal token accounting'] });
    }

    const { eventSource, event_types: events } = context();
    eventSource.on(events.CHAT_COMPLETION_PROMPT_READY, placeMemoryBeforeChat);
    eventSource.on(events.GENERATE_BEFORE_COMBINE_PROMPTS, placeTextMemoryBeforeChat);
    if (onPromptSize) {
        // Observe the combined CC/TC request without delaying it or enforcing a
        // budget. JSON tokenization for CC is explicitly an estimate of input.
        const observe = (data, dryRun) => { void measurePrompt(data, dryRun).catch(() => {}); };
        eventSource.on(events.GENERATE_AFTER_DATA, observe);
    }

    function clear() {
        const s = options();
        context().setExtensionPrompt(PROMPT_KEY, '', s.injectionPosition ?? 1,
            s.injectionDepth ?? 12, s.injectionScan ?? false, s.injectionRole ?? 1);
        lastInjection = '';
        promptSourceChat = null;
        sourceChat = null;
    }

    return { refresh, capture, clear };
}
