import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, putPacket } from '../archive-store.js';
import { installArchiveRuntime } from '../archive-runtime.js';
import { hash } from '../history.js';
import { resolveCalendar, starWarsDate } from '../timeline-calendar.js';
import { readTimeline } from '../timeline-sidecar.js';
import { storySpineSources } from '../story-spine.js';

test('next morning continues the preceding L0 calendar and its epoch is passed to the new request', async () => {
    const archive = createArchive();
    const previous = 'At 22:00 the player rests at the harbor.';
    const quote = 'The next morning you arrive at the market.';
    const context = { chatId: 'calendar-continuity', name1: 'Player', chatMetadata: { worldMemory: {
        calendarAnchor: { label: 'Scenario start', offsetDays: -60, approximate: true, display: 'sw-legends', swYear: 22, swDay: 6 } } },
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
    assert.equal(sentContext.profile.daysPerWeek, 5); assert.equal(sentContext.profile.daysPerStandardMonth, 35);
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

test('a rejected location quotation does not discard the packet duration or other supported visits', () => {
    // Export 1794319950731: one bad quote discarded all four visits and 24h;
    // another packet cited s1 for quotations from s29/s33. Never rebind those.
    const quote = 'The player enters the lower hangar.';
    const sources = storySpineSources([{ id: 'message', text: quote }], { wholeSources: true });
    const date = { text: null, precision: 'unknown' };
    const location = { place: 'hangar', date, offsetHours: 24, status: 'arrived', src: ['s1'], quote };
    const value = { date, elapsedHours: 24, timePrecision: 'exact',
        endTime: { dayOffset: 1, hour: null, period: 'утро', precision: 'approximate' }, locations: [
            { ...location, quote: 'A quotation missing from the source.' }, location,
        ] };
    const result = readTimeline(value, sources, 'Saved prose.');
    assert.equal(result.timeline.elapsedHours, 24);
    assert.equal(result.timeline.locations.length, 1);
    assert.deepEqual(result.timeline.locations[0].sourceIds, ['message']);
    assert.equal(result.timeline.endTime, null);
    assert.match(result.timelineError, /Location 1/u);
    const wrongHandle = readTimeline({ ...value, endTime: null, locations: [{ ...location, src: ['s29'] }] }, sources, 'Saved prose.');
    assert.equal(wrongHandle.timeline.elapsedHours, 24);
    assert.deepEqual(wrongHandle.timeline.locations, []);
    assert.match(wrongHandle.timelineError, /evidence/u);
});

test('a multiple-handle location binds the quotation to its single supporting source', () => {
    // Export 1794319950731: a 60h packet cited [s25,s26], quoting s26.
    const quote = 'The player is now inside the station dome.';
    const sources = storySpineSources([{ id: 'outside', text: 'The player stands outside the station.' },
        { id: 'inside', text: quote }], { wholeSources: true });
    const date = { text: null, precision: 'unknown' };
    const result = readTimeline({ date, elapsedHours: 60, timePrecision: 'exact', locations: [
        { place: 'dome', date, offsetHours: 60, status: 'arrived', src: ['s1', 's2'], quote },
    ] }, sources, 'Saved prose.');
    assert.equal(result.timelineError, null);
    assert.equal(result.timeline.elapsedHours, 60);
    assert.deepEqual(result.timeline.locations[0].sourceIds, ['inside']);
    assert.equal(result.timeline.locations[0].sourceSpans[0].start, 0);
    assert.equal(result.timeline.locations[0].sourceSpans[0].end, quote.length);
});

test('recovered durations retain the fractional day of an imported calendar baseline', () => {
    // Export 1794319950731: 409h + 144h + 24h + 60h lost one hour when
    // dayOffset:1,hour:null overrode the 24h duration of the middle packet.
    const metadata = { worldAtlas: { tracking: { map: { importedSnapshot: {
        format: 'world-atlas-route', binding: { attachment: { empty: true } },
        calendar: { rows: [], now: { elapsedHours: 409, hourKnown: false, approximate: true, incomplete: true } },
    } } } } };
    const packet = (id, order, elapsedHours, dayOffset, locations = []) => ({ id, order, orderKnown: true,
        text: id, textRevision: hash(id), timeline: { textRevision: hash(id), elapsedHours, timePrecision: 'exact',
            endTime: { dayOffset, hour: null, period: null, precision: 'approximate' }, locations } });
    const result = resolveCalendar([packet('first', 0, 144, 6), packet('second', 1, 24, 1),
        packet('third', 2, 60, 2), packet('continuous', 3, 0, 0)], metadata, undefined, []);
    assert.equal(result.now.elapsedHours, 637);
    assert.equal(result.now.gameDay, 27);
    assert.equal(result.now.hourKnown, false);
    assert.equal(result.now.incomplete, true);
});
