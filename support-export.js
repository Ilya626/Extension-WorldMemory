// Read-only support snapshot. Game text is kept verbatim; only connection
// configuration is sanitized. Optional failures never discard other sections.
export function supportSettings(value) {
    if (Array.isArray(value)) return value.map(supportSettings);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (/key$|secret|password|authorization|cookie|headers?|credentials?|access.?token|refresh.?token|bearer/i.test(key)
            || /^token$/i.test(key)) continue;
        if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
            try { const url = new URL(item); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; result[key] = url.href; }
            catch { result[key] = '(invalid URL)'; }
        } else result[key] = supportSettings(item);
    }
    return result;
}

export async function collectSupportBundle({ context, version, settings, worldInfo = {}, inspections = {},
    environment = {}, readBook, readCover }) {
    const copy = value => value === undefined ? null : structuredClone(value);
    const character = copy(context.characters?.[context.characterId]);
    const memory = copy(context.chatMetadata?.worldMemory);
    const bundle = { format: 'world-memory-support-v1', version, createdAt: new Date().toISOString(),
        scope: 'Current chat and its related books; available state at export time. No model request. Connection keys/headers are omitted.',
        chat: { id: context.chatId, groupId: context.groupId || null, playerName: context.name1,
            messages: copy(context.chat), metadata: copy(Object.fromEntries(Object.entries(context.chatMetadata || {})
                .filter(([key]) => key !== 'worldMemory'))), worldMemoryPath: 'backup.state' },
        backup: memory ? { format: 'world-memory-v1', version, state: memory, book: null } : null,
        settings: supportSettings(settings), worldInfo: copy(worldInfo), environment: copy(environment),
        inspections: {}, card: null, cover: null, books: {}, sections: {}, errors: [] };
    const capture = async (name, read, write) => {
        try { write(copy(await read())); bundle.sections[name] = { available: true }; }
        catch (error) {
            const message = String(error?.message || error);
            bundle.sections[name] = { available: false, error: message };
            bundle.errors.push({ section: name, message });
        }
    };
    if (character) await capture('card', () => {
        const native = copy(character), raw = native.json_data; delete native.json_data;
        let stored = null, parseError = null;
        if (typeof raw === 'string') try { stored = JSON.parse(raw); }
        catch (error) { parseError = error.message; }
        return { avatar: character.avatar, native, stored, ...(parseError ? { rawJson: raw, parseError } : {}) };
    }, value => { bundle.card = value; });
    for (const [name, inspect] of Object.entries(inspections))
        await capture(`inspection:${name}`, typeof inspect === 'function' ? inspect : () => inspect,
            value => { bundle.inspections[name] = value; });
    const names = [...new Set([memory?.wiSourceBook, memory?.book, bundle.chat.metadata?.world_info,
        character?.data?.extensions?.world, ...Object.values(worldInfo.bindings || {}).flat()]
        .filter(name => typeof name === 'string' && name.trim()))];
    await Promise.all(names.map(name => capture(`book:${name}`, () => readBook(name), value => {
        bundle.books[name] = value;
        if (bundle.backup && name === memory.book) bundle.backup.book = copy(value);
    })));
    if (character?.avatar && readCover) await capture('cover', () => readCover(character.avatar), value => { bundle.cover = value; });
    bundle.counts = { messages: bundle.chat.messages?.length || 0,
        l0: Object.values(bundle.backup?.state?.archive?.records || {}).filter(record => !record.deleted).length,
        sources: Object.keys(bundle.backup?.state?.archive?.sources || {}).length,
        responses: Object.keys(bundle.backup?.state?.archive?.responses || {}).length,
        books: Object.keys(bundle.books).length, unavailableSections: bundle.errors.length };
    return bundle;
}
