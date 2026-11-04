#!/usr/bin/env node
'use strict';

// Run from the SillyTavern directory while ST is stopped. No cards or chats
// are opened or changed; only png-chunk-text/decode.js and its backup are used.
const fs = require('node:fs');
const marker = '// WorldMemory PNG decoder repair v1';
const decoderSource = `${marker}
'use strict'
module.exports = decode

function decode (data) {
  if (data.data && data.name) data = data.data
  const bytes = Buffer.isBuffer(data) ? data
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data)
  const separator = bytes.indexOf(0)
  if (separator === -1) return { keyword: bytes.toString('latin1'), text: '' }
  if (bytes.indexOf(0, separator + 1) !== -1) {
    throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content')
  }
  return {
    keyword: bytes.toString('latin1', 0, separator),
    text: bytes.toString('latin1', separator + 1)
  }
}
`;

function replaceFile(target, content) {
    const temporary = `${target}.worldmemory-${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { flag: 'wx', mode: fs.statSync(target).mode });
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function repair({ rollback = false, root = process.cwd() } = {}) {
    let target;
    try {
        target = require.resolve('png-chunk-text/decode.js', { paths: [root] });
    } catch {
        throw new Error('png-chunk-text/decode.js was not found. Run this command from your SillyTavern directory after npm install.');
    }
    const backup = `${target}.worldmemory-original`;
    const current = fs.readFileSync(target);
    const fixed = Buffer.from(decoderSource, 'utf8');
    if (rollback) {
        if (!fs.existsSync(backup)) throw new Error(`No repair backup found: ${backup}`);
        const original = fs.readFileSync(backup);
        if (current.equals(original)) return { status: 'already-restored', target, backup };
        if (!current.equals(fixed)) throw new Error('Decoder changed after this repair. Nothing was overwritten; keep the existing file and the backup.');
        replaceFile(target, original);
        return { status: 'restored', target, backup };
    }
    if (current.equals(fixed)) {
        if (!fs.existsSync(backup)) throw new Error('Repaired decoder found, but its original backup is missing. Nothing was changed.');
        return { status: 'already-repaired', target, backup };
    }
    const source = current.toString('utf8');
    if (!/module\.exports\s*=\s*decode/.test(source)
        || !/function\s+decode\s*\(\s*data\s*\)/.test(source)
        || !source.includes('String.fromCharCode')
        || !source.includes('0x00 character is not permitted in tEXt content')) {
        throw new Error('This png-chunk-text decoder is different or already fixed. Nothing was changed.');
    }
    if (fs.existsSync(backup)) {
        if (!current.equals(fs.readFileSync(backup))) throw new Error('Decoder differs from the saved repair backup. Nothing was overwritten.');
    } else {
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    }
    replaceFile(target, fixed);
    return { status: 'repaired', target, backup };
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Run in the SillyTavern directory, with ST stopped:\n  node repair-png-text-decoder.cjs\nThen start ST normally. Cards/chats are unchanged.\nUndo:\n  node repair-png-text-decoder.cjs --rollback\nRe-running the repair is safe. Reapply after npm install/update if needed.');
        return;
    }
    if (args.some(arg => arg !== '--rollback')) throw new Error('Usage: node repair-png-text-decoder.cjs [--rollback]');
    const result = repair({ rollback: args.includes('--rollback') });
    const actions = { repaired: 'PNG decoder repaired.', 'already-repaired': 'PNG decoder is already repaired.',
        restored: 'Original PNG decoder restored.', 'already-restored': 'Original PNG decoder is already restored.' };
    console.log(`${actions[result.status]}\nFile: ${result.target}\nOriginal backup: ${result.backup}\nCards and chats were not changed. Start SillyTavern normally.`);
}

module.exports = { repair, decoderSource };
if (require.main === module) {
    try { main(); }
    catch (error) { console.error(`Repair stopped: ${error.message}`); process.exitCode = 1; }
}
