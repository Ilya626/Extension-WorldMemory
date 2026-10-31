// Installation-local pointers are rebuilt on receipt, never carried as bindings.
export function portableBackup(input) {
    const backup = structuredClone(input);
    if (backup.chat?.metadata) {
        delete backup.chat.metadata.integrity;
        delete backup.chat.metadata.worldMemoryCardImport;
        delete backup.chat.metadata.world_info;
    }
    if (backup.chat?.worldInfo) delete backup.chat.worldInfo.name;
    return backup;
}

export function portableCard(input) {
    const card = structuredClone(input);
    for (const key of ['avatar', 'chat', 'json_data', 'date_added', 'date_last_chat', 'chat_size', 'data_size']) delete card[key];
    for (const extensions of [card.extensions, card.data?.extensions]) {
        if (!extensions) continue;
        delete extensions.world;
        if (extensions.worldMemoryBackup) extensions.worldMemoryBackup = portableBackup(extensions.worldMemoryBackup);
    }
    return card;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function textBytes(text) {
    const bytes = encoder.encode(text), parts = [];
    for (let start = 0; start < bytes.length; start += 32768)
        parts.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
    return encoder.encode(btoa(parts.join('')));
}
function textChunk(keyword, card) {
    const value = textBytes(JSON.stringify(card)), label = encoder.encode(keyword);
    const chunk = new Uint8Array(12 + label.length + 1 + value.length), view = new DataView(chunk.buffer);
    view.setUint32(0, chunk.length - 12);
    chunk.set(encoder.encode('tEXt'), 4); chunk.set(label, 8); chunk.set(value, 9 + label.length);
    let crc = 0xffffffff;
    for (let i = 4; i < chunk.length - 4; i++) crc = crcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
    view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
    return chunk;
}

// Replace card text chunks only. Raster, cover and all other PNG chunks stay byte exact.
export function portablePng(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [bytes.subarray(0, 8)];
    let found = false;
    for (let offset = 8; offset < bytes.length;) {
        const length = view.getUint32(offset), end = offset + length + 12;
        if (end > bytes.length) throw new Error('Invalid character PNG chunk.');
        const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
        let replacement;
        if (type === 'tEXt') {
            const data = bytes.subarray(offset + 8, end - 4), separator = data.indexOf(0);
            const key = decoder.decode(data.subarray(0, separator));
            if (['chara', 'ccv3'].includes(key.toLowerCase())) {
                const binary = atob(decoder.decode(data.subarray(separator + 1)));
                const card = JSON.parse(decoder.decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
                replacement = textChunk(key, portableCard(card)); found = true;
            }
        }
        parts.push(replacement || bytes.subarray(offset, end)); offset = end;
    }
    if (!found) throw new Error('Native export has no character card metadata.');
    return new Blob(parts, { type: 'image/png' });
}
