import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, putPacket } from '../archive-store.js';
import { installArchiveRuntime } from '../archive-runtime.js';
import { hash } from '../history.js';
import { starWarsDate } from '../timeline-calendar.js';

test('next morning continues the preceding L0 calendar and its epoch is passed to the new request', async () => {
    const archive = createArchive();
    const previous = 'At 22:00 the player rests at the harbor.';
    const quote = 'The next morning you arrive at the market.';
    const context = { chatId: 'calendar-continuity', name1: 'Player', chatMetadata: { worldMemory: {
        calendarAnchor: { label: 'Scenario start', offsetDays: -60, approximate: true } } },
        chat: [{ name: 'Player', is_user: true, mes: 'I rest.', sc_message_id: 'old-user' },
            { name: 'Narrator', is_user: false, mes: previous, sc_message_id: 'old-narrator' },
            { name: 'Player', is_user: true, mes: 'I wait until morning.', sc_message_id: 'new-user' },
            { name: 'Narrator', is_user: false, mes: quote, sc_message_id: 'new-narrator' },
            { name: 'Player', is_user: true, mes: 'Pause here.' }], getTokenCountAsync: async text => Math.ceil(text.length / 4) };
    putPacket(archive, { id: 'previous', text: previous, sourceMessageIds: ['old-user', 'old-narrator'], turnRange: [0, 1],
        timeline: { version: 2, textRevision: hash(previous), elapsedHours: 22, timePrecision: 'exact', date: { text: null, precision: 'unknown' }, locations: [] } });
    globalThis.SillyTavern = { getContext: () => context };
    let sentContext;
    const runtime = installArchiveRuntime({ ctx: () => context, getArchive: () => archive, saveArchive: async () => {},
        settings: () => ({ enabled: true, auto: false, retainedContextTokens: 0, blindZoneExchanges: 0,
            ghostUserMessages: false, ghostAssistantMessages: false, summarizerWorldInfo: false }),
        sendRequest: async (_settings, system, prompt) => {
            if (!system.includes('This is stage 1')) throw new Error('Existing optional annotation is offline.');
            sentContext = JSON.parse(/<calendar_context>\s*([\s\S]*?)\s*<\/calendar_context>/u.exec(prompt)[1]);
            return { text: `${quote}\n<story_spine>${JSON.stringify({ text: 'The player goes to the market the next morning.', timeline: {
                date: { text: 'next morning', precision: 'relative' }, elapsedHours: null, timePrecision: 'approximate',
                endTime: { dayOffset: 1, hour: null, period: 'morning', precision: 'approximate' }, locations: [
                    { place: 'market', date: { text: 'next morning', precision: 'relative' }, offsetHours: null,
                        time: { dayOffset: 1, hour: null, period: 'morning', precision: 'approximate' }, status: 'arrived', src: ['s2'], quote },
                ] } })}</story_spine>` };
        } });
    await runtime.summarizeNow();
    assert.equal(sentContext.current.gameDay, 1); assert.equal(sentContext.current.hour, 22);
    assert.equal(sentContext.anchor.offsetDays, -60);
    const result = runtime.snapshot().calendar;
    assert.equal(result.now.gameDay, 2); assert.equal(result.now.period, 'morning');
    assert.equal(result.now.hourKnown, false); assert.equal(result.now.anchorDay, -59);
    assert.equal(result.rows.at(-1).clock.gameDay, 2);
});

test('native Star Wars date and familiar aliases retain one moment across a month boundary', () => {
    const anchor = { display: 'sw-legends', swYear: 22, swDay: 40 };
    const before = starWarsDate({ elapsedHours: 0 }, anchor), after = starWarsDate({ elapsedHours: 24 }, anchor);
    assert.equal(before.month, 1); assert.equal(before.day, 35);
    assert.match(before.native, /Benduday/u); assert.match(before.familiar, /пятница, 35 января 22 ДБЯ/u);
    assert.equal(after.month, 2); assert.equal(after.day, 1); assert.equal(after.year, 22);
    assert.match(after.native, /Primeday · 1\/2 · 22 ДБЯ/u); assert.match(after.familiar, /понедельник, 1 февраля 22 ДБЯ/u);
    assert.doesNotMatch(after.familiar, /2000|2026/u);
});
