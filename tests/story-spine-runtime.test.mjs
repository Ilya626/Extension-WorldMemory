import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, readArchive, readPacket } from '../archive-store.js';
import { installArchiveRuntime } from '../archive-runtime.js';
import { archiveHistoryNodes, archiveStoryNodes, selectHistory } from '../history-selection.js';

function fixture(firstResponse) {
    const archive = createArchive(), saves = [], warnings = [], calls = [];
    const context = { chatId: 'fixture', chatMetadata: {}, chat: [
        { is_user: true, name: 'Player', mes: 'I ask the guard whether the bridge can open.' },
        { is_user: false, name: 'Narrator', mes: 'The guard will open it only after the council replies.' },
        { is_user: true, name: 'Player', mes: 'I wait here.' }],
        getTokenCountAsync: async text => text.split(/\s+/u).length };
    globalThis.SillyTavern = { getContext: () => context };
    const runtime = installArchiveRuntime({ ctx: () => context,
        settings: () => ({ enabled: true, auto: false, retainedContextTokens: 0, blindZoneExchanges: 0,
            ghostUserMessages: false, ghostAssistantMessages: false, summarizerWorldInfo: false }),
        getArchive: () => archive, saveArchive: async () => saves.push(structuredClone(archive)),
        status: text => warnings.push(text), sendRequest: async (_settings, system, prompt) => {
            calls.push({ system, prompt });
            if (calls.length === 1) return { text: firstResponse(prompt), tokenCount: 120, tokenCountSource: 'usage.completion_tokens' };
            if (system.includes('BACKFILL OUTPUT OVERRIDE')) return { text: `<story_spine>${JSON.stringify({
                text: 'The bridge remains conditional on council permission.'
            })}</story_spine>` };
            throw new Error('Optional search metadata service is unavailable.');
        } });
    return { archive, saves, warnings, calls, context, runtime };
}
const prose = 'The player asks about opening the bridge. The guard requires a council reply; permission is still pending.';
function validReply(prompt) {
    return `${prose}\n<story_spine>${JSON.stringify({ text: 'The bridge opening remains conditional on the council response.' })}</story_spine>`;
}

test('a malformed same-call skeleton and unavailable annotation keep the saved L0 durable', async () => {
    const f = fixture(() => `${prose}\n<story_spine>{broken`);
    const result = await f.runtime.summarizeNow();
    assert.equal(result.saved, 1);
    const packet = readArchive(f.archive)[0];
    assert.equal(packet.text, prose);
    assert.equal(packet.storySpine, null);
    assert.ok(packet.storySpineError);
    assert.equal(packet.annotationStatus, 'pending');
    assert.equal(packet.responseTokenCount, 120);
    assert.ok(f.saves.some(saved => Object.values(saved.records).some(p => p.text === prose)));
    assert.ok(f.warnings.some(text => /skeleton is missing/u.test(text)));
    assert.equal(f.calls.length, 2);
    assert.ok(f.context.chat.every(message => !message.is_system));
    const repaired = await f.runtime.backfillStorySpine();
    assert.equal(repaired.saved, 1);
    assert.equal(readPacket(f.archive, packet.id).text, prose);
    assert.ok(f.runtime.snapshot().packets[0].storySpine);
    assert.equal(readPacket(f.archive, packet.id).annotationStatus, 'pending');
    assert.equal(f.calls.length, 3);
    assert.deepEqual(JSON.parse(f.calls[2].prompt), { task: 'Build the missing story skeleton only.',
        saved_summary: prose, source_status: 'linked' });
    assert.equal(readPacket(f.archive, packet.id).storySpine.version, 2);
    assert.equal(readPacket(f.archive, packet.id).storySpine.generationBasis, 'saved-l0');
    assert.deepEqual(await f.runtime.backfillStorySpine(), { saved: 0, summaryOnly: 0, total: 0 });
    assert.equal(f.calls.length, 3);
});

test('source and authored L0 edits invalidate derived skeleton without deleting saved history', async () => {
    const f = fixture(validReply);
    await f.runtime.summarizeNow();
    const id = readArchive(f.archive)[0].id;
    assert.ok(f.runtime.snapshot().packets[0].storySpine);
    f.context.chat[1].mes = 'The guard now refuses to open the bridge.';
    const changed = f.runtime.snapshot();
    assert.equal(changed.packets[0].stale, true);
    assert.equal(changed.packets[0].storySpine, null);
    assert.equal(readPacket(f.archive, id).text, prose);
    await f.runtime.edit(id, 'Manual correction: permission was refused.');
    const manual = f.runtime.snapshot();
    assert.equal(manual.packets[0].storySpine, null);
    assert.equal(manual.packets[0].manual, true);
    const assembled = await selectHistory(archiveHistoryNodes(manual), [], {
        storyNodes: archiveStoryNodes(manual), targetTokens: 8000, countTokens: f.context.getTokenCountAsync });
    assert.ok(assembled.text.includes('Manual correction: permission was refused.'));
    assert.equal(f.calls.length, 2);
});
