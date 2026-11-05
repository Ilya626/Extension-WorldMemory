// One calendar authority for L0 preparation, Atlas route dates and calendar UI.
// Epochs are per chat. No mapping to the computer's current date is implied.
import { hash } from './history.js';
const shortRevision = value => { let h = 2166136261; for (const c of String(value)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(16); };
export function calendarAnchor(metadata = {}) {
    return metadata.worldMemory?.calendarAnchor || Object.values(metadata.worldAtlas?.tracking || {}).find(state => state.calendarStart)?.calendarStart || {};
}
export function calendarProfile(anchor = {}) {
    return anchor.display === 'sw-legends' ? {
        id: 'sw-legends-368', continuity: 'Legends', hoursPerDay: 24, daysPerWeek: 5, daysPerStandardMonth: 35,
        standardMonthsPerYear: 10, daysPerYear: 368,
        intercalary: 'New Year Fete:5 before month1; Festival of Life:5 after month6; Festival of Stars:5 after month9; 3 locally variable holidays placed at year end by this game convention.',
        familiarLabels: 'Names only: the same 5-day weeks, 35-day months and BBY/ABY year. No Gregorian conversion.'
    } : { id: 'game-24h', hoursPerDay: 24, daysPerWeek: null, daysPerStandardMonth: null, daysPerYear: null,
        rule: 'Unspecified week/month/year lengths must not be assumed from Earth; retain uncertainty or use explicit source durations.' };
}
export function calendarTime(value) {
    if (!value) return null;
    if (!Number.isInteger(value.dayOffset) || value.dayOffset < 0
        || (value.hour !== null && value.hour !== undefined && (!Number.isFinite(value.hour) || value.hour < 0 || value.hour >= 24))
        || (value.period && !['morning', 'noon', 'afternoon', 'evening', 'night'].includes(value.period))) throw new Error('Invalid calendar day transition.');
    return { dayOffset: value.dayOffset, hour: value.hour ?? null, period: value.period || null,
        precision: value.precision === 'exact' ? 'exact' : 'approximate' };
}
export function resolveCalendar(packets, metadata = {}, overrideAnchor) {
    const anchor = overrideAnchor || calendarAnchor(metadata), rows = [], resolved = {};
    const atlas = Object.values(metadata.worldAtlas?.tracking || {}).find(state => state.events || state.timing) || {};
    let hours = 0, incomplete = false, approximate = Boolean(anchor.approximate), hourKnown = true, period = null;
    const stamp = () => {
        const day = Math.floor(hours / 24), clock = { elapsedHours: hours, gameDay: day + 1, hour: Math.floor(hours % 24), minute: Math.floor((hours * 60) % 60),
            hourKnown, period, approximate, incomplete, anchorLabel: anchor.label || 'начало игры',
            anchorDay: Number.isFinite(anchor.offsetDays) ? anchor.offsetDays + hours / 24 : null };
        clock.label = formatCalendar(clock, anchor); return clock;
    };
    const advance = (start, step, delta, precision) => {
        if (step) {
            hours = (Math.floor(start / 24) + step.dayOffset) * 24 + (step.hour ?? 0);
            if (hours < start) { incomplete = true; hours = start; }
            hourKnown = step.hour !== null; period = step.period; approximate ||= step.precision !== 'exact';
        } else if (Number.isFinite(delta)) { hours = start + delta; approximate ||= precision !== 'exact'; period = null; }
        else { hours = start; incomplete = true; hourKnown = false; }
        return stamp();
    };
    for (const packet of packets.filter(packet => !packet.stale && !packet.deleted && packet.orderKnown).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
        const source = `l0:${packet.id}`, rev = shortRevision(packet.text), startHours = hours, start = stamp();
        const timeline = packet.timeline?.textRevision === (packet.textRevision || hash(packet.text)) ? packet.timeline : null;
        const timing = atlas.timing?.[source]?.revision === rev ? atlas.timing[source] : null;
        const info = timeline || timing;
        const events = timeline?.locations || (atlas.events || []).filter(event => event.source === source && event.revision === rev);
        const entry = { start, locations: [] }; let latestEventHours = startHours;
        const baseline = { incomplete, approximate, hourKnown, period };
        for (const [offset, event] of events.entries()) {
            ({ incomplete, approximate, hourKnown, period } = baseline);
            const clock = advance(startHours, event.time, event.offsetHours, info?.timePrecision);
            latestEventHours = Math.max(latestEventHours, clock.elapsedHours);
            const row = { ...event, source, index: packet.order, offset: event.offset ?? offset, date: event.date,
                place: event.placeName || event.place, clock };
            rows.push(row); entry.locations.push(clock);
        }
        ({ incomplete, approximate, hourKnown, period } = baseline);
        entry.end = advance(startHours, info?.endTime, info?.elapsedHours, info?.timePrecision);
        if (hours < latestEventHours) { hours = latestEventHours; incomplete = true; entry.end = stamp(); }
        if (!events.length) rows.push({ source, index: packet.order, offset: -1, date: info?.date, place: null, clock: entry.end });
        resolved[packet.id] = entry;
    }
    return { anchor, profile: calendarProfile(anchor), now: stamp(), packets: resolved, rows };
}
export function formatCalendar(clock, anchor = {}) {
    const prefix = clock.incomplete ? 'Не ранее: ≈ ' : clock.approximate ? '≈ ' : '';
    const time = clock.hourKnown === false ? (clock.period ? ` · ${({ morning: 'утро', noon: 'полдень', afternoon: 'день', evening: 'вечер', night: 'ночь' })[clock.period]}` : '')
        : ` ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
    const elapsedDays = Math.floor(clock.elapsedHours / 24);
    let main = `День ${clock.gameDay}${time}`;
    if (anchor.display === 'sw-legends' && Number.isFinite(anchor.swYear)) {
        const date = starWarsDate(clock, anchor);
        main = `${date.native}${time} (${date.familiar}${time})`;
    }
    return `${prefix}${main}${clock.incomplete ? ' · есть неуточнённые интервалы' : ''}`;
}
export function starWarsDate(clock, anchor) {
    const ordinal = Math.max(0, (Number(anchor.swDay) || 1) - 1 + Math.floor(clock.elapsedHours / 24));
    const year = (Number(anchor.swYear) || 0) - Math.floor(ordinal / 368), yearLabel = year > 0 ? `${year} ДБЯ` : `${1 - year} ПБЯ`;
    const segments = [{ title: 'New Year Fete', familiar: 'Новогодний период', length: 5 }];
    for (let month = 1; month <= 10; month++) {
        segments.push({ month, length: 35 });
        if (month === 6) segments.push({ title: 'Festival of Life', familiar: 'Праздник жизни', length: 5 });
        if (month === 9) segments.push({ title: 'Festival of Stars', familiar: 'Праздник звёзд', length: 5 });
    }
    // The three locally variable annual holidays have no universal named dates.
    // This game's declared layout groups them at year end, outside normal months.
    segments.push({ title: 'Local holidays', familiar: 'Местные праздники', length: 3 });
    let within = ordinal % 368;
    const segment = segments.find(segment => { if (within < segment.length) return true; within -= segment.length; return false; });
    const day = within + 1, weekDay = within % 5;
    const nativeDays = ['Primeday', 'Centaxday', 'Taungsday', 'Zhellday', 'Benduday'];
    const familiarDays = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница'];
    const familiarMonths = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября'];
    return { year, ordinal: ordinal % 368 + 1, month: segment.month || null, day, weekDay,
        native: segment.month ? `${nativeDays[weekDay]} · ${day}/${segment.month} · ${yearLabel}` : `${segment.title} ${day} · ${yearLabel}`,
        familiar: segment.month ? `${familiarDays[weekDay]}, ${day} ${familiarMonths[segment.month - 1]} ${yearLabel}` : `${segment.familiar}, день ${day}, ${yearLabel}` };
}
