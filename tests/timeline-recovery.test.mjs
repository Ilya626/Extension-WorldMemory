import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createArchive, putPacket, readPacket } from '../archive-store.js';
import { installArchiveRuntime } from '../archive-runtime.js';
import { createMetadataRecovery } from '../metadata-recovery.js';
import { hash } from '../history.js';

function fixture() {
    const archive = createArchive(), events = new EventEmitter();
    const date = { text: null, precision: 'unknown' };
    const chat = ['The player reaches the port.', 'The player boards the shuttle.', 'The player lands beside the dome.']
        .map((mes, i) => ({ mes, is_user: false, name: 'Narrator', sc_message_id: `m${i}`, extra: { sc_message_id: `m${i}` } }));
    const context = { chatId: 'saved-timeline', chat, chatMetadata: {}, eventSource: events,
        getTokenCountAsync: async text => Math.ceil(text.length / 4) };
    const missing = (id, sources, elapsedHours, locations) => {
        const text = `Saved account of ${id}.`;
        putPacket(archive, { id, kind: 'l0', text, sourceMessageIds: sources,
            timeline: null, timelineError: 'Timeline evidence is missing or out of order. L0 is kept.' });
        const timeline = { date, elapsedHours, timePrecision: 'exact', locations };
        archive.responses ??= {};
        archive.responses[`response-${id}`] = { id: `response-${id}`, stage: 'l0', status: 'complete', packetId: null,
            responseText: `<think>Provider reasoning, excluded from saved prose.</think>\n${text}\n<story_spine>${JSON.stringify({ text: `Outline of ${id}.`, timeline })}</story_spine>` };
    };
    // Observed export failures: wrong handles discard 24h; [s1,s2] citing s2
    // discards 60h. Existing complete prose is the exact response identity.
    missing('day', ['m0'], 24, [{ place: 'port', date, offsetHours: 24, status: 'arrived', src: ['s9'], quote: chat[0].mes }]);
    missing('flight', ['m1', 'm2'], 60, [{ place: 'dome', date, offsetHours: 60, status: 'arrived', src: ['s1', 's2'], quote: chat[2].mes }]);
    let saved = null, saves = 0, calls = 0;
    globalThis.SillyTavern = { getContext: () => context };
    const runtime = installArchiveRuntime({ ctx: () => context, getArchive: () => archive,
        settings: () => ({ enabled: true, auto: false, archiveAuto: false }),
        saveArchive: async () => { saved = structuredClone(archive); saves++; },
        sendRequest: async () => { calls++; throw new Error('No model is needed for saved-response replay.'); } });
    return { archive, context, runtime, events, saved: () => saved, saves: () => saves, calls: () => calls };
}

test('automatic saved-response recovery restores dates and route evidence without model calls or importing a game', async () => {
    const f = fixture(), before = structuredClone(f.archive), chat = JSON.stringify(f.context.chat);
    let completed, failed;
    const done = new Promise((resolve, reject) => { completed = resolve; failed = reject; });
    const queue = createMetadataRecovery({ delay: 0, eventSource: f.events, changedEvents: ['opportunity'],
        isBusy: f.runtime.isBusy,
        read: () => {
            const { packetIds } = f.runtime.inspectTimelineRecovery();
            return packetIds.length ? { key: packetIds.join(','), remaining: packetIds.length, packetIds } : null;
        },
        recover: async (_work, signal) => { try { const result = await f.runtime.recoverSavedTimelines({ signal }); completed(result); }
            catch (error) { failed(error); throw error; } } });
    try {
        f.events.emit('opportunity');
        assert.equal((await done).saved, 2);
        assert.equal(f.calls(), 0);
        assert.equal(f.saves(), 1);
        assert.equal(f.runtime.snapshot().calendar.now.elapsedHours, 84);
        assert.deepEqual(readPacket(f.archive, 'flight').timeline.locations[0].sourceIds, ['m2']);
        assert.equal(JSON.stringify(f.context.chat), chat);
        assert.equal(readPacket(f.archive, 'day').text, before.records.day.text);
        assert.equal(readPacket(f.archive, 'flight').text, before.records.flight.text);
        const reloaded = createArchive(f.saved());
        assert.equal(reloaded.records.flight.timeline.elapsedHours, 60);
        assert.deepEqual(f.runtime.inspectTimelineRecovery().packetIds, []);
    } finally { queue.dispose(); }
});

test('replay is idempotent and never attaches an old response to an edited L0', async () => {
    const f = fixture();
    await f.runtime.edit('day', 'The author corrected the saved account.');
    const edited = readPacket(f.archive, 'day');
    assert.deepEqual(f.runtime.inspectTimelineRecovery().packetIds, ['flight']);
    assert.equal((await f.runtime.recoverSavedTimelines()).saved, 1);
    const after = structuredClone(f.archive), saves = f.saves();
    assert.equal((await f.runtime.recoverSavedTimelines()).saved, 0);
    assert.equal(f.saves(), saves);
    assert.deepEqual(f.archive, after);
    assert.deepEqual(readPacket(f.archive, 'day'), edited);
    assert.equal(f.calls(), 0);
    assert.equal(readPacket(f.archive, 'flight').timeline.textRevision, hash(readPacket(f.archive, 'flight').text));
});
