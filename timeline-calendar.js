// One calendar authority for L0 preparation, Atlas route dates and calendar UI.
// Epochs are per chat. No mapping to the computer's current date is implied.
import { hash } from './history.js';
const shortRevision = value => { let h = 2166136261; for (const c of String(value)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return (h >>> 0).toString(16); };
const importedState = metadata => Object.values(metadata.worldAtlas?.tracking || {}).find(state =>
    state.importedSnapshot?.format === 'world-atlas-route' && Array.isArray(state.importedSnapshot.calendar?.rows)
    && Number.isFinite(state.importedSnapshot.calendar?.now?.elapsedHours) && state.importedSnapshot.calendar.now.elapsedHours >= 0);
export function calendarImportRevision(metadata = {}) {
    const carry = importedState(metadata)?.importedSnapshot;
    return carry ? shortRevision(JSON.stringify([carry.calendarStart, carry.calendar.now, carry.binding?.attachment])) : null;
}
export function calendarAnchor(metadata = {}) {
    return importedState(metadata)?.importedSnapshot.calendarStart || metadata.worldMemory?.calendarAnchor
        || Object.values(metadata.worldAtlas?.tracking || {}).find(state => state.calendarStart)?.calendarStart || {};
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
export function resolveCalendar(packets, metadata = {}, overrideAnchor, chat = null) {
    const imported = importedState(metadata), carry = imported?.importedSnapshot;
    const anchor = overrideAnchor || calendarAnchor(metadata), rows = carry ? structuredClone(carry.calendar.rows) : [], resolved = {};
    const atlas = imported || Object.values(metadata.worldAtlas?.tracking || {}).find(state => state.events || state.timing) || {};
    const attachment = carry?.binding?.attachment;
    let boundary = attachment?.index ?? null;
    if (carry && Array.isArray(chat) && attachment) {
        const hashes = chat.map(message => shortRevision(`${Boolean(message.is_user)}:${String(message.mes || '').replace(/\r\n/g, '\n').trim()}`)), matches = [];
        const wanted = attachment.hashes || [];
        for (let end = wanted.length - 1; wanted.length && end < hashes.length; end++)
            if (wanted.every((value, i) => hashes[end - wanted.length + 1 + i] === value)) matches.push(end);
        boundary = attachment.empty ? -1 : matches.length === 1 ? matches[0] : null;
    }
    let hours = carry?.calendar.now.elapsedHours || 0, incomplete = Boolean(carry?.calendar.now.incomplete || (carry && boundary === null)),
        approximate = Boolean(anchor.approximate || carry?.calendar.now.approximate), hourKnown = carry ? carry.calendar.now.hourKnown !== false : true, period = carry?.calendar.now.period || null;
    const stamp = () => {
        const day = Math.floor(hours / 24), clock = { elapsedHours: hours, gameDay: day + 1, hour: Math.floor(hours % 24), minute: Math.floor((hours * 60) % 60),
            hourKnown, period, approximate, incomplete, anchorLabel: anchor.label || 'начало игры',
            anchorDay: Number.isFinite(anchor.offsetDays) ? anchor.offsetDays + hours / 24 : null };
        clock.label = formatCalendar(clock, anchor); return clock;
    };
    const advance = (start, step, delta, precision) => {
        if (Number.isFinite(delta) && (!step || step.hour === null)) {
            // dayOffset with an unknown hour is a calendar bucket, not midnight.
            // Keep the supported duration (and the starting fractional day).
            hours = start + delta;
            approximate ||= precision !== 'exact' || Boolean(step && step.precision !== 'exact');
            if (step) {
                hourKnown = false;
                if (Math.floor(hours / 24) !== Math.floor(start / 24) + step.dayOffset) { incomplete = true; period = null; }
                else period = step.period || (delta === 0 ? period : null);
            } else if (delta !== 0) period = null;
        } else if (step) {
            hours = (Math.floor(start / 24) + step.dayOffset) * 24 + (step.hour ?? 0);
            if (hours < start) { incomplete = true; hours = start; }
            hourKnown = step.hour !== null; period = step.period; approximate ||= step.precision !== 'exact';
        } else { hours = start; incomplete = true; hourKnown = false; }
        return stamp();
    };
    let overlap = false;
    for (const packet of packets.filter(packet => !packet.stale && !packet.deleted && packet.orderKnown
        && (!carry || (boundary !== null && Math.max(packet.order, packet.turnRange?.[1] ?? -1, ...(packet.sources || []).map(source => source.index)) > boundary)))
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
        const source = `l0:${packet.id}`, rev = shortRevision(packet.text), startHours = hours, start = stamp();
        const candidate = packet.timeline?.textRevision === (packet.textRevision || hash(packet.text)) ? packet.timeline : null;
        const timeline = candidate && (candidate.continuationAfter === undefined || (carry
            && candidate.continuationAfter === boundary && candidate.calendarBaselineRevision === calendarImportRevision(metadata))) ? candidate : null;
        const timing = atlas.timing?.[source]?.revision === rev ? atlas.timing[source] : null;
        const partial = carry && packet.order <= boundary;
        const continued = partial && timeline?.continuationAfter === boundary
            && timeline.calendarBaselineRevision === calendarImportRevision(metadata);
        overlap ||= Boolean(partial);
        const info = partial && !continued ? { elapsedHours: null, timePrecision: 'unknown' } : timeline || timing;
        let events = timeline?.locations || (atlas.events || []).filter(event => event.source === source && event.revision === rev);
        if (partial && !continued) events = events.flatMap(event => {
            const indices = (event.sourceIds || []).map(id => packet.sources?.find(source => source.id === id)?.index).filter(Number.isFinite);
            if (indices.length && indices.every(index => index <= boundary)) return [];
            return [{ ...event, offsetHours: null, time: null, boundaryUncertain: !indices.length || indices.some(index => index <= boundary) }];
        });
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
    const now = stamp();
    if (carry && boundary === null) now.importedHistorical = true;
    return { anchor, profile: calendarProfile(anchor), now, packets: resolved, rows,
        ...(carry ? { imported: true, importBoundary: boundary, importOverlap: overlap } : {}) };
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
