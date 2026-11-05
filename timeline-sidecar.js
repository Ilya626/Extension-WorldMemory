// Same L0 request, optional data only. Never normalize the author's calendar.
import { hash } from './history.js';
import { calendarTime } from './timeline-calendar.js';
export const TIMELINE_INSTRUCTION = `Inside the SAME story_spine JSON object add "timeline":{"date":{"text":null,"precision":"unknown"},"elapsedHours":0,"timePrecision":"exact","locations":[]}.
Set date.text to the story date/period exactly as supported, retaining its calendar, wording and qualifiers; precision is exact, approximate, relative or unknown. Do not invent a calendar or date, convert units/calendars, or resolve relative time to an invented absolute date. Unknown uses text:null.
elapsedHours is the duration of THIS packet since its starting state (the end of previous_l0), in hours. Convert supported elapsed days/hours and time-of-day transitions to a number; use timePrecision exact or approximate to retain the source's precision. Use 0 for continuous scenes with no established time jump, and null with timePrecision unknown only for a stated passage of time that cannot be quantified. Never derive travel duration from distance, lore or a planned trip. This numeric delta lets the reader accumulate game Day N from a user-defined start; an approximate epoch does not prevent computing elapsed days.
For locations list only the actual PLAYER's established presence and completed arrivals/departures in this new packet's chronological order: {"place":"world/place as written","date":{"text":null,"precision":"unknown"},"offsetHours":0,"status":"arrived","src":["s1"],"quote":"exact contiguous source quotation supporting that player location"}. offsetHours is elapsed time from this packet's START to this location event, in the same hour units; null if unknown. Do not exceed a known elapsedHours. Use status departed only after completed departure, without inventing arrival. Preserve return visits. A place need not exist on a map. Dates may be exact, approximate, relative or unknown; repeat the supported date for each location, never assume a missing date is exact.
Exclude place mentions, lore, plans, proposed/future/conditional trips, memories, dreams, dialogue claims, NPC-only travel, OOC directions and hidden master decisions. Do not choose or advance the player's actions. Use the supplied new source handles and their verbatim quotes; previous_l0 is continuity only, not a new visit. If no location is established return locations:[]; missing evidence is unknown, not a made-up visit. Keep the full L0 prose and compact outline unchanged in purpose. This adds no extra API call.`;
export const CALENDAR_INSTRUCTION = `The supplied calendar_context is the ONE fixed game-start epoch plus the already accumulated date at the start of this packet. Continue that same scale; never reset it from this packet's prose. In timeline add endTime:{"dayOffset":0,"hour":null,"period":null,"precision":"approximate"}; each location may include time with the same fields, relative to the packet START calendar day. "The next morning" means dayOffset:1,period:"morning",hour:null unless an actual hour is stated. "Three days later" advances three calendar days. An explicit elapsed number may instead use elapsedHours/offsetHours. A continuous scene retains the starting day; retain unknown hour rather than inventing one. Use original linked sources to recover temporal transitions omitted from a legacy summary. Only actual elapsed story time counts, never a planned trip, quote or recollection. Calendar dates are epoch + accumulated actual elapsed time; the approximate epoch remains approximate, but does not make day progression uncomputable. Do not replace established calendar state with a free list of relative phrases.`;
function dateValue(value) {
    if (!value || !['exact', 'approximate', 'relative', 'unknown'].includes(value.precision)
        || (value.precision !== 'unknown' && (typeof value.text !== 'string' || !value.text.trim()))) throw new Error('Invalid story date or precision.');
    return { text: value.precision === 'unknown' ? null : value.text.trim(), precision: value.precision };
}
export function readTimeline(value, sources, text) {
    if (value === undefined) return { timeline: null, timelineError: 'Timeline metadata was not returned; L0 is kept.' };
    try {
        if (!Array.isArray(value?.locations)) throw new Error('Timeline needs locations.');
        const date = dateValue(value.date), byHandle = new Map(sources.map((source, index) => [source.handle, { ...source, order: index }]));
        const elapsedHours = value.elapsedHours === undefined ? null : value.elapsedHours;
        if (elapsedHours !== null && (!Number.isFinite(elapsedHours) || elapsedHours < 0)) throw new Error('Invalid elapsed hours.');
        const timePrecision = value.timePrecision || 'unknown';
        if (!['exact', 'approximate', 'unknown'].includes(timePrecision)) throw new Error('Invalid elapsed-time precision.');
        let previousOrder = -1, previousOffset = -1, previousHours = -1;
        const locations = value.locations.map(item => {
            if (!item?.place?.trim() || !['arrived', 'departed'].includes(item.status) || !Array.isArray(item.src) || item.src.length !== 1)
                throw new Error('Invalid player location.');
            const source = byHandle.get(item.src[0]);
            const offset = source && typeof item.quote === 'string' && item.quote.trim().length >= 8 ? source.text.indexOf(item.quote) : -1;
            if (!source || source.sourceKind === 'saved-summary' || !(offset >= 0)
                || source.order < previousOrder || (source.order === previousOrder && offset < previousOffset))
                throw new Error('Timeline evidence is missing or out of order.');
            previousOrder = source.order; previousOffset = offset;
            const span = source.sourceSpans?.[0];
            const offsetHours = item.offsetHours === undefined ? null : item.offsetHours;
            if (offsetHours !== null && (!Number.isFinite(offsetHours) || offsetHours < 0 || (elapsedHours !== null && offsetHours > elapsedHours)))
                throw new Error('Location time is outside its packet.');
            if (offsetHours !== null && offsetHours < previousHours) throw new Error('Location times are out of order.');
            if (offsetHours !== null) previousHours = offsetHours;
            return { place: item.place.trim(), date: dateValue(item.date), offsetHours, time: calendarTime(item.time), status: item.status, quote: item.quote,
                sourceIds: [source.id], sourceSpans: span ? [{ ...span, start: span.start + offset, end: span.start + offset + item.quote.length }] : [] };
        });
        return { timeline: { version: 2, textRevision: hash(text), date, elapsedHours, timePrecision, endTime: calendarTime(value.endTime), locations }, timelineError: null };
    } catch (error) { return { timeline: null, timelineError: `${error.message} L0 is kept.` }; }
}
