import test from 'node:test';import assert from 'node:assert/strict';
import { projectLegacyWI, createWIDiffState, getWIDiffContext, applyWIDiffResponse, retryWIDiffItems, discardEmptyWIDiffProposal } from '../wi-diff.js';

function fixture() {
    const sources = { s0: { revision: 'r0', index: 0 }, s1: { revision: 'r1', index: 1 }, s2: { revision: 'r2', index: 2 } };
    const packets = [{ id: 'p0', text: 'Первый L0.', sourceMessageIds: ['s0'], sourceFingerprints: { s0: 'r0' }, sources: [{ id: 's0', index: 0, text: 'Первый исходник.' }] },
        { id: 'p2', text: 'Поздний L0.', sourceMessageIds: ['s2'], sourceFingerprints: { s2: 'r2' }, sources: [{ id: 's2', index: 2, text: 'Поздний исходник.' }] }];
    const book = { entries: { 1: { uid: 1, comment: 'Позднее имя', key: ['Поздний псевдоним'], content: 'Поздний текущий профиль.', extensions: { worldMemory: { owner: 'owner', manual: false, contributions: {
        p0: { sourceMessageIds: ['s0'], subjectName: 'Алиса', subjectType: 'character', facts: 'Алиса ждёт ключ.\nАлиса живёт в башне.' },
        p2: { sourceMessageIds: ['s2'], subjectName: 'Позднее имя', subjectType: 'character', facts: 'Поздняя тайна.' }
    } } } }, 2: { uid: 2, content: 'Ручной профиль.', extensions: { worldMemory: { owner: 'owner', manual: true, contributions: {} } } } } };
    const state = createWIDiffState({ owner: 'owner', book: 'book', records: projectLegacyWI(book, packets, { owner: 'owner', cutoff: 0 }) });
    const options = (s, packetId, proposalId, sourceId) => ({ baseHead: s.confirmed.head, packetId, proposalId,
        through: sources[sourceId].index, sourceMessageIds: [sourceId], sources, allowedUIDs: [1], protectedUIDs: [2] });
    const add = { uid: 1, name: 'Алиса', type: 'character', main: false, keys: ['Алиса'], facts: 'Алиса получила ключ.' };
    return { book, packets, sources, state, options, add };
}

test('addressed WI diff retires only the selected claim and retains source history and old views', () => {
    const f = fixture(), before = structuredClone(f.book), original = f.state.confirmed.claims.find(c => c.text.includes('ждёт ключ'));
    const pending = applyWIDiffResponse(f.state, { version: 1, review: null, add: [f.add], remove: [{ id: original.id, revision: original.revision }] }, f.options(f.state, 'p1', 'proposal1', 's1'));
    const accepted = applyWIDiffResponse(pending, { version: 1, review: { proposalId: 'proposal1', decision: 'accept' }, add: [], remove: [] }, f.options(pending, 'p2', 'review2', 's2'));
    const now = getWIDiffContext(accepted, { sources: f.sources }).records[0].facts;
    assert.match(now, /получила ключ/);assert.match(now, /живёт в башне/);assert.doesNotMatch(now, /ждёт ключ/);
    assert.ok(accepted.confirmed.claims.find(c => c.id === original.id).retired);
    assert.deepEqual(accepted.confirmed.claims.find(c => c.id === original.id).retired.sources, { s1: 'r1', s2: 'r2' });
    assert.match(getWIDiffContext(accepted, { sources: f.sources, cutoff: 1 }).records[0].facts, /ждёт ключ/);
    assert.deepEqual(f.book, before);assert.equal(f.state.confirmed.claims.length, 2);
});

test('pending WI stays outside confirmed references and rejection leaves the confirmed base unchanged', () => {
    const f = fixture();
    const pending = applyWIDiffResponse(f.state, { version: 1, review: null, add: [f.add], remove: [] }, f.options(f.state, 'p1', 'proposal1', 's1'));
    assert.deepEqual(getWIDiffContext(pending, { sources: f.sources }).records, getWIDiffContext(f.state, { sources: f.sources }).records);
    const rejected = applyWIDiffResponse(pending, { version: 1, review: { proposalId: 'proposal1', decision: 'reject' }, add: [], remove: [] }, f.options(pending, 'p2', 'review2', 's2'));
    assert.deepEqual(rejected.confirmed, f.state.confirmed);assert.equal(rejected.pending, null);
    assert.throws(() => applyWIDiffResponse(f.state, { version: 1, review: null, add: [{ ...f.add, uid: 2 }], remove: [] }, f.options(f.state, 'p1', 'manual', 's1')), /manual|foreign|unknown/);
});

test('historical WI projection hides future facts and aliases; stale source/base diffs are rejected', () => {
    const f = fixture(), prefix = projectLegacyWI(f.book, f.packets, { owner: 'owner', cutoff: 1 });
    assert.equal(prefix[0].name, 'Алиса');assert.deepEqual(prefix[0].keys, ['Алиса']);assert.doesNotMatch(JSON.stringify(prefix), /Поздн/);
    const wire = { version: 1, review: null, add: [f.add], remove: [] }, options = f.options(f.state, 'p1', 'proposal1', 's1');
    assert.throws(() => applyWIDiffResponse(f.state, wire, { ...options, baseHead: 'changed' }), /base/);
    const pending = applyWIDiffResponse(f.state, wire, options);
    assert.throws(() => applyWIDiffResponse(pending, { version: 1, review: { proposalId: 'proposal1', decision: 'accept' }, add: [], remove: [] }, {
        ...f.options(pending, 'p2', 'review2', 's2'), sources: { ...f.sources, s1: { ...f.sources.s1, revision: 'edited' } }
    }), /source|revision/);
    assert.equal(pending.pending.id, 'proposal1');
});


test('rejected temporary identities are localized and review survives the next proposal', () => {
 const f=fixture(), fresh={...f.add,uid:null,subject:'new:3'};
 const prior=applyWIDiffResponse(f.state,{version:1,review:null,add:[fresh],remove:[]},f.options(f.state,'p1','old','s1'));
 const issues=[], wire={version:1,review:{proposalId:'old',decision:'reject'},add:[{...fresh,subject:'old:new:3'}, {...fresh,subject:'old:new:7'}],remove:[]};
 const next=applyWIDiffResponse(prior,wire,{...f.options(prior,'p2','new','s2'),issues});
 assert.equal(next.lastReview.decision,'reject'); assert.equal(next.pending.add.length,2); assert.deepEqual(issues,[]);
 assert.notEqual(next.pending.add[0].subject,next.pending.add[1].subject);
});

test('partial preserves valid items and review, holds removals and survives replay', () => {
 const f=fixture(), claim=f.state.confirmed.claims[0], issues=[];
 const wire={version:1,review:null,add:[{...f.add,uid:2},f.add],remove:[{id:claim.id,revision:claim.revision}]};
 const options={...f.options(f.state,'p1','proposal','s1'),issues};
 const next=applyWIDiffResponse(f.state,wire,options);
 assert.equal(next.pending.add.length,1); assert.equal(next.pending.remove.length,0); assert.equal(issues.length,2);
 const again=[]; applyWIDiffResponse(next,wire,{...options,issues:again}); assert.deepEqual(again,issues);
 const proposal=applyWIDiffResponse(f.state,{version:1,review:null,add:[{...f.add,facts:'Keep this.\nReject this.'}],remove:[{id:claim.id,revision:claim.revision}]},f.options(f.state,'p1','semantic','s1'));
 const [good,bad]=proposal.pending.add;
 const review={proposalId:'semantic',decision:'partial',items:[{id:good.id,decision:'accept'},{id:bad.id,decision:'reject',reason:'Unsupported'}, {id:claim.id,decision:'reject',reason:'Still current'}]};
 const reviewedWire={version:1,review,add:[],remove:[]}, reviewOptions=f.options(proposal,'p2','review-semantic','s2');
 const reviewed=applyWIDiffResponse(proposal,reviewedWire,reviewOptions);
 assert.ok(reviewed.confirmed.claims.some(c=>c.id===good.id)); assert.ok(!reviewed.confirmed.claims.some(c=>c.id===bad.id));
 assert.ok(!reviewed.confirmed.claims.find(c=>c.id===claim.id).retired);
 assert.deepEqual(reviewed.reviewHistory.semantic.proposal,proposal.pending); assert.deepEqual(reviewed.reviewHistory.semantic.review,review);
 assert.deepEqual(applyWIDiffResponse(reviewed,reviewedWire,reviewOptions),reviewed);
 for (const items of [review.items.slice(0,2), [...review.items,{...review.items[0]}], [{...review.items[0],id:'unknown'},...review.items.slice(1)], [review.items[0],{...review.items[1],reason:''},review.items[2]]])
  assert.throws(()=>applyWIDiffResponse(proposal,{...reviewedWire,review:{...review,items}},reviewOptions),/partial review/);
 assert.equal(proposal.pending.add.length,2);
 const fresh={...f.add,uid:null,subject:'new:1',facts:'Accepted.\nRejected.'}, other={...fresh,subject:'new:2',facts:'Rejected entirely.'};
 const prior=applyWIDiffResponse(f.state,{version:1,review:null,add:[fresh,other],remove:[]},f.options(f.state,'p1','identities','s1'));
 const [kept,dropped,allDropped]=prior.pending.add;
 const identities=applyWIDiffResponse(prior,{version:1,review:{proposalId:'identities',decision:'partial',items:[{id:kept.id,decision:'accept'},{id:dropped.id,decision:'reject',reason:'unsupported'},{id:allDropped.id,decision:'reject',reason:'unsupported'}]},add:[{...fresh,subject:kept.subject,facts:'Continues.'},{...other,subject:allDropped.subject,facts:'New evidence.'}],remove:[]},f.options(prior,'p2','identity-review','s2'));
 assert.equal(identities.pending.add[0].subject,kept.subject);
 assert.notEqual(identities.pending.add[1].subject,allDropped.subject);
});

test('targeted correction adds only failed items and keeps original pending claims', () => {
 const f=fixture(), issues=[], wire={version:1,review:null,add:[f.add,{...f.add,uid:2}],remove:[]};
 const pending=applyWIDiffResponse(f.state,wire,{...f.options(f.state,'p1','proposal','s1'),issues});
 const result=retryWIDiffItems(pending,{add:[{...f.add,facts:'A second fact.'}],remove:[]},{...f.options(pending,'p1','retry','s1'),originalProposalId:'proposal'});
 assert.equal(result.state.pending.add.length,2); assert.equal(result.state.pending.add[0].text,f.add.facts);
 assert.deepEqual(result.issues,[]); assert.equal(result.state.confirmed.head,pending.confirmed.head);
 const fresh={...f.add,uid:null,subject:'new:1'};
 const p2=applyWIDiffResponse(f.state,{version:1,review:null,add:[fresh],remove:[]},f.options(f.state,'p1','original','s1'));
 for (const subject of ['new:1','original:new:1']) {
  const r=retryWIDiffItems(p2,{add:[{...fresh,subject,facts:'Another fact.'}],remove:[]},{...f.options(p2,'p1',`retry-${subject}`,'s1'),originalProposalId:'original'});
  assert.equal(r.state.pending.add[1].subject,r.state.pending.add[0].subject);
 }
 const empty=structuredClone(p2); empty.pending.add=[];
 assert.equal(discardEmptyWIDiffProposal(empty,'original').pending,null);
 assert.equal(discardEmptyWIDiffProposal(p2,'original'),null);
});
