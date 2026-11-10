import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createMetadataRecovery } from '../metadata-recovery.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
function fixture(recover) {
    const events = new EventEmitter(), state = { work: null, busy: false };
    const queue = createMetadataRecovery({ read: () => state.work, recover,
        isBusy: () => state.busy, eventSource: events, changedEvents: ['changed', 'idle'],
        chatChangedEvent: 'chat', stopEvent: 'stop', delay: 0 });
    return { events, state, queue };
}
test('new L0 starts recovery without a button, changes during active survive, and successful chunks drain', async () => {
    const calls = []; let release;
    const f = fixture(async work => {
        calls.push(work.packetIds);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        else if (calls.length === 2) f.state.work = { inputKey: 'new-l0-during-run', key: 'one-left', remaining: 1, packetIds: ['last-gap'] };
        else f.state.work = null;
    });
    try {
        f.queue.notify(); await settle(); assert.equal(calls.length, 0);
        f.state.busy = true; f.state.work = { inputKey: 'new-l0', key: 'first-gap', remaining: 6, packetIds: ['first-gap'] };
        f.events.emit('changed'); await settle(); assert.equal(calls.length, 0);
        f.state.busy = false; f.events.emit('idle'); await settle();
        f.state.work = { inputKey: 'new-l0-during-run', key: 'next-chunk', remaining: 5, packetIds: ['next-chunk'] };
        f.events.emit('changed'); release(); await settle(); await settle();
        assert.deepEqual(calls, [['first-gap'], ['next-chunk'], ['last-gap']]);
    } finally { f.queue.dispose(); }
});
test('unchanged failure does not multiply calls; a connection change during the failed request survives', async () => {
    let calls = 0, rejectFirst;
    const f = fixture(async () => {
        calls++;
        if (calls === 1) await new Promise((_resolve, reject) => { rejectFirst = reject; });
        throw Error('Unavailable provider');
    });
    try {
        f.state.work = { inputKey: 'connection-1', key: 'same-gap', remaining: 1, packetIds: ['gap'] };
        f.events.emit('changed'); await settle();
        f.state.work = { inputKey: 'connection-2', key: 'same-gap-new-connection', remaining: 1, packetIds: ['gap'] };
        f.events.emit('changed'); rejectFirst(Error('Old connection failed')); await settle();
        for (let i = 0; i < 20; i++) { f.events.emit('changed'); f.events.emit('idle'); }
        await settle(); assert.equal(calls, 2);
    } finally { f.queue.dispose(); }
});
test('Stop and chat change abort recovery, release abort handlers, and dispose removes event listeners', async () => {
    const signals = []; const f = fixture(async (_work, signal) => {
        signals.push(signal);
        await new Promise((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
            signal.addEventListener('abort', abort, { once: true });
        });
    });
    try {
        f.state.work = { key: 'first-chat', packetIds: ['gap'] }; f.queue.notify(); await settle();
        f.events.emit('stop'); await settle(); f.events.emit('idle'); await settle();
        assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true);
        assert.equal(getEventListeners(signals[0], 'abort').length, 0);
        f.state.work = { key: 'first-chat-new-l0', packetIds: ['gap', 'new'] }; f.events.emit('changed'); await settle();
        f.state.work = null; f.events.emit('chat'); await settle();
        assert.equal(signals.length, 2); assert.equal(signals[1].aborted, true);
        assert.equal(getEventListeners(signals[1], 'abort').length, 0);
        f.queue.dispose(); assert.equal(f.events.eventNames().length, 0);
    } finally { f.queue.dispose(); }
});
