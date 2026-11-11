// Local replay of already received L0 output. No model calls or prose edits.
import { readStorySpine, storySpineSources } from './story-spine.js';

export function savedTimelineUpdates(packets, responses, clean = text => text.trim()) {
    const byText = new Map();
    for (const packet of packets) {
        if (!byText.has(packet.text)) byText.set(packet.text, []);
        byText.get(packet.text).push(packet);
    }
    const updates = new Map();
    const saved = Object.values(responses || {}).filter(response => ['l0', 'refine-l0'].includes(response.stage)
        && response.status === 'complete' && !response.partial && typeof response.responseText === 'string')
        .sort((a, b) => (a.finishedAt || a.startedAt || 0) - (b.finishedAt || b.startedAt || 0));
    for (const response of saved) {
        const output = clean(response.responseText), marker = output.indexOf('<story_spine>');
        if (marker < 0) continue;
        const prose = output.slice(0, marker).trim();
        const matches = (byText.get(prose) || []).filter(packet => !response.packetId || response.packetId === packet.id);
        // A matching phrase/outline/quote is insufficient: the complete saved
        // prose must match exactly, with only one possible current packet.
        if (matches.length !== 1) continue;
        const packet = matches[0];
        if (packet.stale || packet.deleted || packet.manual || packet.kind !== 'l0'
            || packet.sourceStatus !== 'linked' || packet.timeline?.textRevision === packet.textRevision) continue;
        const sources = storySpineSources(packet.sources, { wholeSources: true });
        const parsed = readStorySpine(output, sources);
        if (parsed.text !== packet.text || !parsed.timeline) continue;
        updates.set(packet.id, { timeline: { ...parsed.timeline, textRevision: packet.textRevision,
            sourceFingerprints: packet.sourceFingerprints, sourceStatus: 'linked', recoveredFromResponse: response.id },
            timelineError: parsed.timelineError });
    }
    return updates;
}
