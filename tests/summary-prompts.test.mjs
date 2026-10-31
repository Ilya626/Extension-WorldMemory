import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchive, readArchive} from '../archive-store.js';
import {installArchiveRuntime, DEFAULT_SYSTEM, DEFAULT_USER} from '../archive-runtime.js';
import {SUMMARY_PROMPT_KEYS, copyLegacyPrompt, rememberPromptOrigin, describePromptOrigin, resetSummaryPrompts} from '../summary-prompt-settings.js';

test('Regenerate sends exactly the two displayed stage prompts, saving L0 before stage 2', async () => {
    const archive=createArchive(), calls=[], saves=[];
    const settings={enabled:true, auto:false, summarizerWorldInfo:false, retainedContextTokens:0, blindZoneExchanges:0,
        ghostUserMessages:false, ghostAssistantMessages:false, summarizerSystemPrompt:'CUSTOM_STAGE_ONE', summaryLanguage:'ru'};
    const context={chatId:'bridge',chatMetadata:{},name1:'Player',chat:[
        {name:'Player',is_user:true,mes:'I ask whether the bridge can open.'},
        {name:'Guard',is_user:false,mes:'The bridge opens only after a council reply.'}],getTokenCountAsync:async text=>text.length/4};
    globalThis.SillyTavern={getContext:()=>context};
    const prose='The player asks about the bridge. The guard requires the council reply before opening it.';
    const runtime=installArchiveRuntime({ctx:()=>context,settings:()=>settings,getArchive:()=>archive,
        saveArchive:async()=>saves.push(structuredClone(archive)),sendRequest:async(_settings,system,prompt)=>{
            calls.push({system,prompt});
            if(system.includes('This is stage 1'))return {text:`${prose}\n<story_spine>{"text":"The bridge requires council permission."}</story_spine>`};
            assert.ok(saves.some(saved=>Object.values(saved.records).some(row=>row.text===prose)));
            return {text:'<memory_metadata>{"lprime":"The bridge requires council permission.","facts":[]}</memory_metadata>'};
        }});
    await runtime.summarizeNow();const id=readArchive(archive)[0].id;calls.length=0;saves.length=0;
    await runtime.regenerate(id);
    assert.equal(calls.length,2);
    const view=runtime.inspectPrompts();assert.equal(view.requests.length,2);
    assert.deepEqual(view.requests.map(row=>[row.systemPrompt,row.userPrompt]),calls.map(row=>[row.system,row.prompt]));
    assert.equal(view.requests[0].stage,'l0');assert.equal(view.requests[1].stage,'metadata');
    assert.equal(view.requests[0].systemPrompt,view.l0System);
    assert.equal(view.requests[1].systemPrompt,view.metadataSystem);
    assert.match(view.requests[0].systemPrompt,/CUSTOM_STAGE_ONE/);
    assert.doesNotMatch(view.requests[1].systemPrompt,/CUSTOM_STAGE_ONE/);
    const text=readArchive(archive)[0].text;assert.equal(text,prose);
});

test('legacy prompt origins, manual edits and explicit reset never silently reimport prompts', () => {
    const settings={}, legacy={summarizerSystemPrompt:'OLD_SYSTEM',summarizerUserPrompt:'OLD_USER'};
    for(const key of SUMMARY_PROMPT_KEYS)copyLegacyPrompt(settings,legacy,key);
    assert.match(describePromptOrigin('summarizerSystemPrompt',settings,legacy),/копия из Summaryception/);
    legacy.summarizerSystemPrompt='LATER_LEGACY_CHANGE';copyLegacyPrompt(settings,legacy,'summarizerSystemPrompt');
    assert.equal(settings.summarizerSystemPrompt,'OLD_SYSTEM');
    settings.summarizerSystemPrompt='MY_SYSTEM';rememberPromptOrigin(settings,'summarizerSystemPrompt');
    assert.match(describePromptOrigin('summarizerSystemPrompt',settings,legacy),/пользователем/);
    resetSummaryPrompts(settings);
    for(const key of SUMMARY_PROMPT_KEYS)copyLegacyPrompt(settings,legacy,key);
    assert.equal(settings.summarizerSystemPrompt||DEFAULT_SYSTEM,DEFAULT_SYSTEM);
    assert.equal(settings.summarizerUserPrompt||DEFAULT_USER,DEFAULT_USER);
    assert.match(describePromptOrigin('summarizerSystemPrompt',settings,legacy),/Встроенный/);
    const old={summarizerSystemPrompt:legacy.summarizerSystemPrompt};
    assert.match(describePromptOrigin('summarizerSystemPrompt',old,legacy),/не был записан/);
});
