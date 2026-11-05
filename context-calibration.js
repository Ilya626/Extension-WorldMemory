// Explicit, local calibration of main-context estimates; never provider usage.
export function contextCalibrationScope(context) {
    if (context.mainApi !== 'openai') return null;
    const settings = context.chatCompletionSettings || {};
    const source = settings.chat_completion_source || '';
    // A native null can mean "Website Model" or another unknown selection.
    // A tokenizer alias or stale custom_model cannot identify the actual model.
    const model = context.getChatCompletionModel?.(settings);
    if (!model) return null;
    let endpoint = source === 'custom' ? settings.custom_url : settings.reverse_proxy;
    if (endpoint) {
        try { const url = new URL(endpoint); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; endpoint = url.href.replace(/\/$/, ''); }
        catch { endpoint = ''; }
    }
    const profile = context.extensionSettings?.connectionManager?.selectedProfile || '';
    return { key: JSON.stringify([source, endpoint || '', model, profile]), model, source, endpoint: endpoint || '', profile };
}

export function contextCalibration(context, counterKey) {
    const scope = contextCalibrationScope(context);
    const sample = scope && context.extensionSettings?.worldMemory?.contextCalibrations?.[scope.key];
    const valid = sample && Number.isInteger(sample.proxyTokens) && sample.proxyTokens > 0
        && Number.isInteger(sample.providerInputTokens) && sample.providerInputTokens > 0;
    const active = Boolean(valid && sample.counterKey === counterKey);
    return { scope, sample: valid ? sample : null, active, factor: active ? sample.providerInputTokens / sample.proxyTokens : 1,
        status: active ? 'one-sample-approximation' : valid ? 'local-counter-changed' : 'uncalibrated' };
}

export function saveContextCalibration(context, counterKey, proxyTokens, providerInputTokens) {
    const scope = contextCalibrationScope(context);
    if (!scope) throw new Error('Select a Chat Completion connection and model.');
    proxyTokens = Number(proxyTokens); providerInputTokens = Number(providerInputTokens);
    if (!Number.isInteger(proxyTokens) || proxyTokens <= 0 || !Number.isInteger(providerInputTokens) || providerInputTokens <= 0)
        throw new Error('Enter positive local proxy and provider input counts from the same request.');
    const settings = context.extensionSettings.worldMemory;
    settings.contextCalibrations ??= {};
    settings.contextCalibrations[scope.key] = { proxyTokens, providerInputTokens, counterKey, samples: 1, appliedAt: new Date().toISOString() };
    return contextCalibration(context, counterKey);
}

export function resetContextCalibration(context) {
    const scope = contextCalibrationScope(context);
    if (scope && context.extensionSettings?.worldMemory?.contextCalibrations)
        delete context.extensionSettings.worldMemory.contextCalibrations[scope.key];
}
