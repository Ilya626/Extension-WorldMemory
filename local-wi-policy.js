import { readSummaryWI } from './memory.js';

// Review IDs are local to the saved response; malformed neighbours are never facts.
export function localReviewItems(updates) {
    const items = [], issues = [], seen = new Set();
    if (!Array.isArray(updates)) return {items, issues:[{index:null,message:'Missing updates array.'}]};
    for (const [i, update] of updates.entries()) {
        try {
            const [parsed] = readSummaryWI({updates:[update]});
            if (parsed.uid !== null && seen.has(parsed.uid)) throw new Error('Repeated native UID.');
            if (parsed.uid !== null) seen.add(parsed.uid);
            for (const [j,text] of parsed.facts.split(/\r?\n/).filter(x=>x.trim()).entries())
                items.push({id:`${i}:${j}`,name:parsed.name,uid:parsed.uid,text});
        } catch (error) { issues.push({index:i,message:error.message}); }
    }
    return {items,issues};
}
export function nextLocalReviewPacket(packets, boundary, memory, revision) {
    return packets.find(p => p.order < boundary && !p.stale && memory.wiPackets?.[p.id]?.status === 'pending-local-review'
        && memory.wiLocalReviewErrors?.[p.id]?.revision !== revision(p) && Array.isArray(p.memoryMetadata?.wi?.updates));
}
export function reviewedUpdates(updates, review) {
    const {items,issues} = localReviewItems(updates), decisions = new Map(review.items.map(item=>[item.id,item.decision]));
    const preserve = updates.flatMap((update,i) => update && review.items.some(item => item.id.startsWith(`${i}:`) && item.decision === 'reject')
        ? [{uid:update.uid,name:update.name,type:update.type}] : []);
    const accepted = updates.flatMap((update,i) => {
        if (!update || issues.some(issue=>issue.index===i)) return [];
        const facts = items.filter(item=>item.id.startsWith(`${i}:`) && decisions.get(item.id)==='accept').map(item=>item.text).join('\n');
        return facts ? [{...update,content:'',facts}] : [];
    });
    return {updates:accepted,preserve,issues};
}
export function mergePreservedFacts(previous, next, preserve) {
    return preserve && previous ? [...new Set(`${previous}\n${next}`.split(/\r?\n/).filter(line=>line.trim()))].join('\n') : next;
}
export function contributionAction(mode, saved) { return mode ? saved ? 'review' : 'prepare' : 'legacy'; }
export function forkSourceBooks(memory) { return [...new Set([memory?.forkSourceBook,...(memory?.forkSourceBooks || [])].filter(Boolean))]; }
