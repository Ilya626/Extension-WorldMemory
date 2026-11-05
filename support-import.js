import { OWNER, compactRevision, packetSignature } from './memory.js';
import { archiveSnapshot } from './archive-store.js';
import { rebindKnowledgeIdentities } from './knowledge-runtime.js';
import { unpackCardBackup } from './card-transfer.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = message => { throw new Error(`WorldMemory import: ${message}`); };
const baseName = name => name.replace(/\s+Import_\(\d+\)$/i, '').trim();
const nativeName = name => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim();
const attemptRevision = packet => compactRevision([packetSignature(packet),
    packet.memoryMetadata?.wiDiff || packet.memoryMetadata?.wi || null, packet.memoryMetadata?.wiContext || null]);

/** Inspect content after selection; do not hide files based on their extension. */
export async function readSupportFile(file, { convertCharacterBook } = {}) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
    const decoder = new TextDecoder();
    let card, cover;
    if (png) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), raster = [bytes.subarray(0, 8)];
        let v2, v3, ended = false;
        for (let offset = 8; offset + 12 <= bytes.length;) {
            const length = view.getUint32(offset), end = offset + length + 12;
            if (end > bytes.length) fail('PNG обрезан: данные карточки не импортированы.');
            const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
            let cardChunk = false;
            if (type === 'tEXt') {
                const data = bytes.subarray(offset + 8, end - 4), separator = data.indexOf(0);
                const key = separator < 0 ? '' : decoder.decode(data.subarray(0, separator)).toLowerCase();
                if (key === 'chara' || key === 'ccv3') {
                    cardChunk = true;
                    if (key === 'ccv3') v3 = data.subarray(separator + 1); else v2 = data.subarray(separator + 1);
                }
            }
            if (!cardChunk) raster.push(bytes.subarray(offset, end));
            offset = end;
            if (type === 'IEND') { ended = true; break; }
        }
        if (!ended || (!v3 && !v2)) fail('В PNG нет карточки персонажа ST. Выберите оригинальный PNG-файл карточки или полный экспорт JSON.');
        try {
            const binary = atob(decoder.decode(v3 || v2));
            card = JSON.parse(decoder.decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
        } catch { fail('Не удалось прочитать данные карточки внутри PNG.'); }
        // Only the raster is carried as cover; embedded snapshots are not duplicated.
        cover = new Blob(raster, { type: 'image/png' });
    } else {
        let value;
        try { value = JSON.parse(decoder.decode(bytes)); }
        catch { fail('Файл не распознан. Нужен PNG карточки с вложенной игрой или полный экспорт JSON.'); }
        if (value?.format === 'world-memory-support-v1') return value;
        card = value;
    }
    const backup = await unpackCardBackup(card?.data?.extensions?.worldMemoryBackup || card?.extensions?.worldMemoryBackup);
    if (backup?.format !== 'world-memory-v1' || backup.chat?.format !== 'world-memory-chat-v1'
        || !Array.isArray(backup.chat.messages) || !backup.state)
        fail('В карточке нет вложенной полной игры WorldMemory. Обычную карточку импортируйте через ST; для переноса игры нужен PNG с сохранённой игрой или «Экспорт всего» JSON.');
    const state = backup.state, metadata = copy(backup.chat.metadata || {}), books = {};
    if (state.book && backup.book?.entries) books[state.book] = backup.book;
    const author = backup.chat.worldInfo;
    if (author?.data?.entries) books[author.name || metadata.world_info || state.wiSourceBook || state.book] = author.data;
    const embedded = card.data?.character_book || card.character_book;
    const characterBook = card.data?.extensions?.world || card.extensions?.world || state.wiSourceBook || state.book;
    if (embedded?.entries?.length && characterBook && !books[characterBook] && convertCharacterBook)
        books[characterBook] = convertCharacterBook(embedded);
    if (characterBook) {
        card.data ||= {}; card.data.extensions ||= {};
        card.data.extensions.world = characterBook;
    }
    if (!metadata.world_info && author?.data?.entries) metadata.world_info = author.name || state.wiSourceBook || state.book;
    // The existing complete-import validator rejects unavailable referenced books.
    return { format: 'world-memory-support-v1', version: backup.version,
        chat: { id: state.chatId, messages: backup.chat.messages, metadata }, backup,
        card: { stored: card, avatar: backup.chat.character?.avatar }, books,
        worldInfo: { bindings: { character: characterBook, chat: metadata.world_info } },
        cover: cover ? { blob: cover } : null };
}

// Only installation pointers are rewritten. Source text, responses, entry content,
// source IDs and revision evidence keep their original values.
function rebind(value, books, oldOwner, owner, oldChat, chatId) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') {
            if (['book', 'authorBook', 'world', 'world_info', 'wiSourceBook', 'cloneFrom'].includes(key) && books.has(item)) value[key] = books.get(item);
            else if (oldOwner && ['owner', 'branch', 'cloneOwner'].includes(key) && item === oldOwner) value[key] = owner;
            else if (key === 'chatId' && item === oldChat) value[key] = chatId;
        } else rebind(item, books, oldOwner, owner, oldChat, chatId);
    }
}

function rebindCharacterFilters(value, originals, avatar) {
    if (!value || typeof value !== 'object') return;
    const target = avatar.replace(/\.png$/i, '');
    for (const [key, item] of Object.entries(value)) {
        if (['characterFilter', 'character_filter'].includes(key) && Array.isArray(item?.names))
            item.names = item.names.map(name => originals.has(name) ? target : name);
        else rebindCharacterFilters(item, originals, avatar);
    }
}

/** A full-game restore may have a new chat ID, while still containing every
 * original. Memory-only imports with missing/changed sources stay conservative. */
export function rebindCompleteBackup(backup, { owner, chatId, bookName, messages, avatar, characterNames = [], authorBook = '' }) {
    const saved = backup.state, archive = saved?.archive;
    if (!archive?.records || !backup.book?.entries || !Array.isArray(messages)) return null;
    const idOf = message => message.sc_message_id || message.extra?.sc_message_id || message.id;
    const originals = new Map(Object.entries(archive.sources || {}).map(([id, source]) => [idOf(source) || id, source]));
    for (const source of backup.chat?.messages || []) if (idOf(source)) originals.set(idOf(source), source);
    const required = new Set(Object.values(archive.records).flatMap(record => record.sourceMessageIds || []));
    for (const claim of saved.wiDiffState?.confirmed?.claims || [])
        for (const id of [...Object.keys(claim.sources || {}), ...Object.keys(claim.retired?.sources || {})]) required.add(id);
    for (const id of Object.keys(saved.wiDiffState?.pending?.sources || {})) required.add(id);
    if (backup.chat?.messages) for (const source of backup.chat.messages) if (idOf(source)) required.add(idOf(source));
    if (!required.size) return null;
    const receiving = new Map();
    for (const message of messages) if (idOf(message)) {
        const id = idOf(message); if (receiving.has(id)) return null;
        receiving.set(id, message);
    }
    for (const id of required) {
        const original = originals.get(id), current = receiving.get(id);
        if (!original || !current || (original.mes ?? original.text) !== (current.mes ?? current.text)
            || Boolean(original.is_user ?? original.isUser) !== Boolean(current.is_user ?? current.isUser)
            || original.name !== current.name) return null;
    }
    const names = new Map([[saved.book, bookName]].filter(([name]) => name));
    if (saved.wiSourceBook && saved.wiSourceBook !== saved.book && authorBook) names.set(saved.wiSourceBook, authorBook);
    const state = copy(saved), book = copy(backup.book);
    rebind(book, names, saved.owner, owner, saved.chatId, chatId);
    if (book.name === saved.book) book.name = bookName;
    const sourceCharacter = backup.chat?.character || {};
    const originalCharacters = new Set([...characterNames, sourceCharacter.name, sourceCharacter.avatar,
        sourceCharacter.avatar?.replace(/\.png$/i, '')].filter(Boolean));
    if (avatar) rebindCharacterFilters(book, originalCharacters, avatar);
    if (saved.book) rebindKnowledgeIdentities(state.archive,
        { book: backup.book, world: saved.book, owner: saved.owner }, { book, world: bookName, owner });
    rebind(state, names, saved.owner, owner, saved.chatId, chatId);
    state.owner = owner; state.chatId = chatId; state.book = bookName;
    const previous = new Map(archiveSnapshot(archive, { chat: backup.chat?.messages || messages }, { effective: false }).packets.map(packet => [packet.id, packet]));
    for (const packet of archiveSnapshot(state.archive, { chat: messages }, { effective: false }).packets) {
        const receipt = state.wiPackets?.[packet.id], before = previous.get(packet.id);
        if (receipt && before && receipt.revision === attemptRevision(before)) receipt.revision = attemptRevision(packet);
    }
    return { state, book, bindings: Object.fromEntries(names) };
}

/** Prepare a separate character and chat. This function has no native writes or
 * settings side effects; every required section is checked before publication. */
export function prepareSupportImport(bundle, { characterNames = [], avatarNames = [], bookNames = [],
    owner = crypto.randomUUID(), chatId = `WorldMemory-${crypto.randomUUID()}` } = {}) {
    if (bundle?.format !== 'world-memory-support-v1') fail('choose a WorldMemory-all JSON export.');
    const sourceCard = bundle.card?.stored || bundle.card?.native;
    const originalName = sourceCard?.data?.name || sourceCard?.name;
    if (!object(sourceCard) || typeof originalName !== 'string' || !originalName.trim()) fail('the export has no character card.');
    if (bundle.chat?.groupId) fail('group chat exports cannot be imported as an individual character.');
    if (!Array.isArray(bundle.chat?.messages) || bundle.chat.messages.some(row => !object(row) || typeof row.mes !== 'string')) fail('the export has no valid complete chat.');
    if (!object(bundle.chat.metadata) || !object(bundle.books)) fail('chat metadata or related books are missing.');
    if (bundle.backup && (bundle.backup.format !== 'world-memory-v1' || !object(bundle.backup.state))) fail('invalid memory backup.');
    const saved = bundle.backup?.state;
    if (bundle.chat.metadata[OWNER] && !saved) fail('the complete memory backup is unavailable; existing data was not changed.');
    if (saved?.archive && (!object(saved.archive.records) || !object(saved.archive.sources))) fail('invalid memory archive.');
    for (const record of Object.values(saved?.archive?.records || {}))
        if (!object(record) || typeof record.id !== 'string' || typeof record.text !== 'string' || !Array.isArray(record.sourceMessageIds)) fail('invalid archive packet.');
    const bindings = bundle.worldInfo?.bindings || {};
    const required = [saved?.book, saved?.wiSourceBook, saved?.cloneFrom, bundle.chat.metadata.world_info,
        sourceCard.data?.extensions?.world, ...Object.values(bindings).flat()].filter(name => typeof name === 'string' && name);
    for (const name of required) if (!Object.hasOwn(bundle.books, name)) fail(`related WI book is unavailable: ${name}`);
    for (const [name, book] of Object.entries(bundle.books)) {
        if (!name.trim() || !object(book?.entries) || Object.values(book.entries).some(entry => !object(entry)
            || !Number.isInteger(entry.uid) || !Array.isArray(entry.key) || typeof entry.content !== 'string')) fail('invalid related WI book.');
    }
    const bookBases = new Map(Object.keys(bundle.books).map(name => [name, nativeName(baseName(name))]));
    if (new Set([...bookBases.values()].map(name => name.toLocaleLowerCase())).size !== bookBases.size) fail('related book names collide after removing the import suffix.');
    const occupied = names => new Set(names.filter(name => typeof name === 'string').map(name => name.toLocaleLowerCase()));
    const characters = occupied([...characterNames, ...avatarNames.map(name => name.replace(/\.png$/i, ''))]);
    const worlds = occupied(bookNames), cardBase = baseName(originalName), fileBase = nativeName(cardBase);
    if (!fileBase || [...bookBases.values()].some(name => !name)) fail('empty native name.');
    let number = 1;
    while (characters.has(`${cardBase} Import_(${number})`.toLocaleLowerCase())
        || characters.has(`${fileBase} Import_(${number})`.toLocaleLowerCase())
        || [...bookBases.values()].some(name => worlds.has(`${name} Import_(${number})`.toLocaleLowerCase()))) number++;
    const suffix = `Import_(${number})`, name = `${cardBase} ${suffix}`, fileName = `${fileBase} ${suffix}`;
    const originalAvatar = bundle.card.avatar || bundle.card.native?.avatar;
    const originalCharacters = new Set([originalName, originalAvatar, originalAvatar?.replace(/\.png$/i, '')].filter(Boolean));
    const rebindFilters = value => rebindCharacterFilters(value, originalCharacters, fileName);
    const names = new Map([...bookBases].map(([old, base]) => [old, `${base} ${suffix}`]));
    const books = Object.fromEntries([...names].map(([old, next]) => [next, copy(bundle.books[old])]));
    const state = saved ? copy(saved) : null, metadata = copy(bundle.chat.metadata), messages = copy(bundle.chat.messages);
    // The fresh compressed backup replaces every stale embedded copy. Avoid
    // cloning a possibly very large legacy snapshot merely to discard it.
    const extensions = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== 'worldMemoryBackup'));
    const card = copy({ ...sourceCard, extensions: extensions(sourceCard.extensions),
        data: { ...sourceCard.data, extensions: extensions(sourceCard.data?.extensions) } });
    for (const key of ['avatar', 'chat', 'json_data', 'date_added', 'date_last_chat', 'chat_size', 'data_size']) delete card[key];
    card.name = name; card.data.name = name;
    card.spec ||= 'chara_card_v2'; card.spec_version ||= '2.0';
    for (const [old, next] of names) {
        rebind(books[next], names, saved?.owner, owner, saved?.chatId, chatId);
        rebindFilters(books[next]);
        if (books[next].name === old) books[next].name = next;
    }
    if (state?.archive && names.has(saved.book)) rebindKnowledgeIdentities(state.archive,
        { book: bundle.books[saved.book], world: saved.book, owner: saved.owner },
        { book: books[names.get(saved.book)], world: names.get(saved.book), owner });
    rebind(state, names, saved?.owner, owner, saved?.chatId, chatId);
    rebind(metadata, names, saved?.owner, owner, saved?.chatId, chatId);
    for (const ext of [card.extensions, card.data.extensions]) rebind(ext, names, saved?.owner, owner, saved?.chatId, chatId);
    if (card.data.character_book) {
        rebind(card.data.character_book, names, saved?.owner, owner, saved?.chatId, chatId);
        rebindFilters(card.data.character_book);
        if (names.has(card.data.character_book.name)) card.data.character_book.name = names.get(card.data.character_book.name);
    }
    // A chat-only source still needs a valid native card binding: otherwise ST
    // offers to reimport its stale embedded lorebook when this copy is selected.
    const cardWorld = bindings.character || sourceCard.data?.extensions?.world || bundle.chat.metadata.world_info || saved?.wiSourceBook || saved?.book;
    if (cardWorld && names.has(cardWorld)) card.data.extensions.world = names.get(cardWorld);
    delete metadata.integrity; delete metadata.worldMemoryCardImport;
    if (state) {
        state.owner = owner; state.chatId = chatId;
        if (state.archive) {
            const previous = new Map(archiveSnapshot(saved.archive, { chat: bundle.chat.messages }, { effective: false }).packets.map(packet => [packet.id, packet]));
            for (const packet of archiveSnapshot(state.archive, { chat: messages }, { effective: false }).packets) {
                const receipt = state.wiPackets?.[packet.id], before = previous.get(packet.id);
                // Refresh only receipts that were current in the exported chat.
                // A stale/error result must not become applied by importing it.
                if (receipt && before && receipt.revision === attemptRevision(before)) receipt.revision = attemptRevision(packet);
            }
        }
        metadata[OWNER] = state;
    }
    // Preserve support-only material for a later export/review, without applying
    // connection profiles, global WI selection or another installation's settings.
    const previousImport = metadata.worldMemoryImport;
    metadata.worldMemoryImport = { format: bundle.format, version: bundle.version, createdAt: bundle.createdAt,
        importedAt: new Date().toISOString(), suffix, originalChatId: bundle.chat.id,
        books: Object.fromEntries(names), settings: copy(bundle.settings || {}), worldInfo: copy(bundle.worldInfo || {}),
        environment: copy(bundle.environment || {}), inspections: copy(bundle.inspections || {}),
        sections: copy(bundle.sections || {}), errors: copy(bundle.errors || []), ...(previousImport ? { previousImport } : {}) };
    const primary = card.data.extensions.world || metadata.world_info;
    const extraBooks = [...new Set(Object.values(bindings).flat().filter(value => names.has(value)).map(value => names.get(value)))].filter(value => value !== primary && value !== metadata.world_info);
    return { name, fileName, suffix, chatId, card, books, metadata, messages, extraBooks,
        backup: state ? { format: 'world-memory-v1', version: bundle.backup.version, state,
            book: state.book ? books[state.book] || null : null,
            chat: { format: 'world-memory-chat-v1', messages, metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== OWNER)),
                ...(metadata.world_info && books[metadata.world_info] ? { worldInfo: { name: metadata.world_info, data: books[metadata.world_info] } } : {}) } } : null };
}
