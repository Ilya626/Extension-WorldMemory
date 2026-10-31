export const SUMMARY_PROMPT_KEYS = ['summarizerSystemPrompt', 'summarizerUserPrompt'];

export function rememberPromptOrigin(settings, key, source = 'manual') {
    settings.summaryPromptOrigins ??= {};
    settings.summaryPromptOrigins[key] = { source, value: settings[key] };
}

export function copyLegacyPrompt(settings, legacy, key) {
    if (settings[key] !== undefined || legacy[key] === undefined) return;
    settings[key] = structuredClone(legacy[key]);
    rememberPromptOrigin(settings, key, 'summaryception');
}

export function describePromptOrigin(key, settings, legacy = {}) {
    if (!settings[key]) return 'Встроенный WorldMemory';
    const stamp = settings.summaryPromptOrigins?.[key];
    if (stamp?.value === settings[key]) return stamp.source === 'summaryception'
        ? 'Однократная копия из Summaryception; последующего наследования нет'
        : 'Изменено пользователем в WorldMemory';
    if (legacy[key] === settings[key])
        return 'Сохранено в WorldMemory; совпадает с Summaryception. Источник старой записи не был записан';
    return 'Сохранённый текст WorldMemory; исторический источник неизвестен';
}

export function resetSummaryPrompts(settings) {
    for (const key of SUMMARY_PROMPT_KEYS) {
        settings[key] = '';
        delete settings.summaryPromptOrigins?.[key];
    }
}
