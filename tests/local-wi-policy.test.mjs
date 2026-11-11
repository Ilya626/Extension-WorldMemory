import test from 'node:test';
import assert from 'node:assert/strict';
import { localReviewItems, nextLocalReviewPacket, reviewedUpdates, mergePreservedFacts, contributionAction, forkSourceBooks } from '../local-wi-policy.js';
import { migrateConfirmedContributions } from '../contribution-migration.js';
import { sourceFingerprint } from '../archive-store.js';
import { hash } from '../history.js';
import { retainedContent } from '../memory.js';

const good = {uid:1,name:'Person',type:'character',main:false,keys:['Person'],facts:'First fact.\nSecond fact.',content:''};
test('migrated force update never routes a missing saved WI to legacy model application',()=>{
 assert.equal(contributionAction(true,false),'prepare'); assert.equal(contributionAction(true,true),'review'); assert.equal(contributionAction(false,false),'legacy');
 assert.deepEqual(forkSourceBooks({forkSourceBook:'branch-1',forkSourceBooks:['origin','branch-1']}),['branch-1','origin']);
});
test('malformed WI item is isolated; an unchanged failed review does not block next L0',()=>{
 const updates=[null,good], result=localReviewItems(updates);
 assert.deepEqual(result.items.map(x=>x.id),['1:0','1:1']); assert.equal(result.issues.length,1);
 const packets=[{id:'bad',order:1,memoryMetadata:{wi:{updates}}},{id:'good',order:2,memoryMetadata:{wi:{updates:[good]}}}];
 const memory={wiPackets:{bad:{status:'pending-local-review'},good:{status:'pending-local-review'}},wiLocalReviewErrors:{bad:{revision:'r'}}};
 assert.equal(nextLocalReviewPacket(packets,3,memory,()=> 'r').id,'good');
 assert.equal(nextLocalReviewPacket(packets,3,memory,()=> 'changed').id,'bad');
});
test('partial and full rejection preserve existing confirmed facts',()=>{
 const review={items:[{id:'1:0',decision:'accept'},{id:'1:1',decision:'reject',reason:'unsupported'}]};
 const result=reviewedUpdates([null,good],review);assert.equal(result.issues.length,1);assert.equal(result.updates[0].facts,'First fact.');
 assert.equal(result.preserve[0].uid,1);assert.equal(mergePreservedFacts('Earlier confirmed.','First fact.',true),'Earlier confirmed.\nFirst fact.');
 assert.equal(reviewedUpdates([good],{items:[{id:'0:0',decision:'reject'},{id:'0:1',decision:'reject'}]}).updates.length,0);
 const accepted=reviewedUpdates([{...good,facts:'New fact.'}],{items:[{id:'0:0',decision:'accept'}]});
 assert.equal(mergePreservedFacts('Earlier confirmed.\nAnother confirmed.',accepted.updates[0].facts,true),
     'Earlier confirmed.\nAnother confirmed.\nNew fact.');
});
test('migration retains confirmed provenance and invalidates recorded review locally',()=>{
 const chat=[{sc_message_id:'s1',mes:'source',name:'A'},{sc_message_id:'s2',mes:'review',name:'B'}];
 const rev=m=>`${sourceFingerprint(m)}:${hash(m.mes)}`, refs={s1:rev(chat[0])}, reviewRefs={s2:rev(chat[1])};
 const claim={id:'p:add:0',subject:'uid:1',uid:1,name:'Person',type:'character',main:false,keys:['Person'],text:'Fact.',packetId:'l0',sources:refs,order:0,acceptedThrough:1,revision:'r'};
 const packet={id:'l0',text:'summary',order:0,sourceMessageIds:['s1'],sourceFingerprints:refs,sources:[{id:'s1',text:'source',index:0}]};
 const journal={owner:'o',book:'b',branch:'o',confirmed:{claims:[claim]},reviewHistory:{p:{through:1,sources:reviewRefs,review:{decision:'partial',items:[{id:claim.id,decision:'accept'}]}}}};
 const memory={owner:'o',book:'b',wiDiffState:journal,archive:{records:{}}};
 const book={entries:{1:{uid:1,comment:'Person',key:['Person'],content:'Fact.',extensions:{worldMemory:{owner:'o',contributions:{}}}}}};
 const snapshot={chat,packets:[packet]}, migrated=migrateConfirmedContributions(book,memory,snapshot);
 const c=migrated.book.entries[1].extensions.worldMemory.contributions.l0;
 assert.equal(c.facts,'Fact.');assert.equal(c.journalClaims[0].id,claim.id);assert.equal(c.reviewDependencies[0].kind,'recorded-review');
 c.contributionOrigin='l0'; c.subjectName='Updated identity'; c.subjectType='place';
 const repeated=migrateConfirmedContributions(migrated.book,memory,snapshot);
 assert.deepEqual(repeated.affected,[]);
 assert.equal(repeated.book.entries[1].extensions.worldMemory.contributions.l0.subjectName,'Updated identity');
 assert.equal(repeated.book.entries[1].extensions.worldMemory.contributions.l0.subjectType,'place');
 const changed=structuredClone(snapshot);changed.chat[1].mes='edited';
 const invalid=migrateConfirmedContributions(book,memory,changed);assert.equal(invalid.book.entries[1].extensions.worldMemory.contributions.l0.facts,'');
 assert.equal(invalid.unresolved[0].reason,'review-source-changed');assert.deepEqual(invalid.invalidated,[1]);assert.equal(book.entries[1].content,'Fact.');
 const edited=structuredClone(memory), old=edited.wiDiffState.confirmed.claims[0];old.retired={through:1,sources:reviewRefs};
 const replacement={...old,id:'editorial:add:0',packetId:'editorial:synthetic',text:'Corrected fact.'};delete replacement.retired;
 edited.wiDiffState.confirmed.claims.push(replacement);
 edited.wiDiffState.editorialCorrections=[{items:[{claimId:old.id,replacement:replacement.text}]}];
 const corrected=migrateConfirmedContributions(book,edited,snapshot);
 assert.match(retainedContent(corrected.book.entries[1]),/Corrected fact/);
 assert.doesNotMatch(retainedContent(corrected.book.entries[1]),/^Fact\.$/);
});
