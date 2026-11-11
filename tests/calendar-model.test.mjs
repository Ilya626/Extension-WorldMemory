import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createArchive, putPacket, readPacket } from '../archive-store.js';
import { installArchiveRuntime } from '../archive-runtime.js';
import { hash } from '../history.js';

function fixture(send) {
    const archive = createArchive(), events = new EventEmitter();
    const quote = 'The next morning you arrive at the harbor.';
    let context = { chatId: 'calendar-model', chatMetadata: {}, eventSource: events,
        chat: [{ name: 'Narrator', is_user: false, mes: quote, sc_message_id: 'source', extra: { sc_message_id: 'source' } }],
        getTokenCountAsync: async text => Math.ceil(text.length / 4) };
    const text = 'The player reaches the harbor after the overnight rest.';
    const date = { text: null, precision: 'unknown' };
    putPacket(archive, { id: 'packet', kind: 'l0', text, sourceMessageIds: ['source'],
        timeline: { version: 2, textRevision: hash(text), date, elapsedHours: 3, timePrecision: 'approximate',
            locations: [{ place: 'previously confirmed harbor', date, status: 'arrived', offsetHours: 3, quote, sourceIds: ['source'] }] } });
    globalThis.SillyTavern = { getContext: () => context };
    let calls = 0, saves = 0, saveHook = null, durable = null;
    const runtime = installArchiveRuntime({ ctx: () => context, getArchive: () => archive,
        saveArchive: async () => { saves++; await saveHook?.(); durable = structuredClone(archive); }, settings: () => ({ enabled: true, auto: false, archiveAuto: false }),
        sendRequest: async (...args) => { calls++; return send(...args); } });
    const response = prompt => {
        const payload = JSON.parse(prompt);
        assert.equal(payload.packets[0].sources[0].text, quote);
        return { text: JSON.stringify({ packets: [{ id: payload.packets[0].id, timeline: {
            date: { text: 'next morning', precision: 'relative' }, elapsedHours: null, timePrecision: 'approximate',
            endTime: { dayOffset: 1, hour: null, period: 'morning', precision: 'approximate' },
            locations: [{ place: 'harbor', date: { text: 'next morning', precision: 'relative' }, offsetHours: null,
                time: { dayOffset: 1, hour: null, period: 'morning', precision: 'approximate' }, status: 'arrived', src: [payload.packets[0].sources[0].handle], quote }],
        } }], note: 'The hour remains unknown.' }) };
    };
    return { archive, runtime, response, context: () => context, switchChat: () => { context = { ...context, chatId: 'other', chat: [], chatMetadata: {} }; },
        calls: () => calls, saves: () => saves, setSaveHook: hook => { saveHook = hook; }, durable: () => durable };
}

test('one explicit calendar action sends one request and applies only derived dates and locations', async () => {
    let f;
    f = fixture(async (_settings, system, prompt) => {
        assert.match(system, /calendar/i);
        return f.response(prompt);
    });
    const before = readPacket(f.archive, 'packet'), chat = JSON.stringify(f.context().chat);
    const result = await f.runtime.clarifyCalendar();
    assert.equal(f.calls(), 1);
    assert.equal(f.saves(), 1);
    assert.equal(result.saved, 1);
    assert.equal(result.calendar.now.gameDay, 2);
    assert.equal(result.calendar.now.period, 'morning');
    assert.equal(result.calendar.now.hourKnown, false);
    assert.equal(readPacket(f.archive, 'packet').text, before.text);
    assert.equal(JSON.stringify(f.context().chat), chat);
    assert.deepEqual(readPacket(f.archive, 'packet').timeline.locations[0].sourceIds, ['source']);
});

test('provider failure and Stop preserve all previously saved calendar data', async () => {
    const failed = fixture(async () => { throw Error('Provider unavailable'); });
    const previous = readPacket(failed.archive, 'packet');
    await assert.rejects(failed.runtime.clarifyCalendar(), /Provider unavailable/);
    assert.deepEqual(readPacket(failed.archive, 'packet'), previous);
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const stopped = fixture(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const saved = readPacket(stopped.archive, 'packet');
    const pending = stopped.runtime.clarifyCalendar();
    await began; stopped.runtime.stop();
    await assert.rejects(pending, /Stopped/);
    release({ text: '{}' });
    assert.deepEqual(readPacket(stopped.archive, 'packet'), saved);
    assert.equal(stopped.calls(), 1);
    let invalid;
    invalid = fixture(async (_settings, _system, prompt) => {
        const response = invalid.response(prompt), body = JSON.parse(response.text);
        body.packets[0].timeline.locations[0].quote = 'Unsupported model quotation.';
        return { text: JSON.stringify(body) };
    });
    const invalidBefore = readPacket(invalid.archive, 'packet');
    const partial = await invalid.runtime.clarifyCalendar();
    assert.match(partial.note, /Частичный результат/);
    assert.deepEqual(readPacket(invalid.archive, 'packet').timeline.locations, invalidBefore.timeline.locations);
    assert.match(readPacket(invalid.archive, 'packet').timelineError, /Location 1/);
    for (const operation of ['save failure', 'Stop during save']) {
        let f;
        f = fixture(async (_settings, _system, prompt) => f.response(prompt));
        const before = readPacket(f.archive, 'packet');
        f.setSaveHook(() => {
            if (f.saves() !== 1) return;
            if (operation === 'save failure') throw Error('Persistence failed');
            f.runtime.stop();
        });
        await assert.rejects(f.runtime.clarifyCalendar(), /Persistence failed|Stopped/);
        assert.deepEqual(readPacket(f.archive, 'packet'), before);
        assert.deepEqual(f.durable().records.packet, before);
    }
});

test('partial calendar response keeps supported date, new and previously confirmed locations', async () => {
    let f;
    f = fixture(async (_settings, _system, prompt) => {
        const response = f.response(prompt), body = JSON.parse(response.text);
        const timeline = body.packets[0].timeline;
        timeline.locations[0].quote = 'you arrive at the harbor';
        timeline.locations.push({ ...timeline.locations[0], place: 'unsupported', quote: 'Unsupported model quotation.' });
        return { text: JSON.stringify(body) };
    });
    const result = await f.runtime.clarifyCalendar();
    const saved = readPacket(f.archive, 'packet');
    assert.equal(saved.timeline.date.text, 'next morning');
    assert.deepEqual(saved.timeline.locations.map(location => location.place), ['previously confirmed harbor', 'harbor']);
    assert.match(saved.timelineError, /Location 2/);
    assert.match(result.note, /Частичный результат/);
});

test('an answer from an earlier chat or source revision cannot overwrite the current calendar', async () => {
    for (const change of ['chat', 'source']) {
        let started, release, f;
        const began = new Promise(resolve => { started = resolve; });
        f = fixture(async (_settings, _system, prompt) => { started(); return new Promise(resolve => { release = () => resolve(f.response(prompt)); }); });
        const before = readPacket(f.archive, 'packet');
        const pending = f.runtime.clarifyCalendar();
        await began;
        if (change === 'chat') f.switchChat();
        else f.context().chat[0].mes = 'The author corrected this source message.';
        release();
        await assert.rejects(pending, /changed|изменились/i);
        assert.deepEqual(readPacket(f.archive, 'packet'), before);
        assert.equal(f.calls(), 1);
    }
});
