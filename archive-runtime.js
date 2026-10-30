// One archive writer. The archive is never a full-context inference injection.
import { archiveSnapshot, readArchive, readPacket, putPacket, deletePacket } from './archive-store.js';
import { sourceId, collectPassage, captureSourceFingerprints, resolveSnippetSources } from './vendor/summaryception/summary-sources.js';
import { planRawContext, blindZoneStart } from './vendor/summaryception/raw-context.js';
import { syncContextOverrides, setContextForMessages, applySummaryContextPolicy } from './vendor/summaryception/context-control.js';
import { sendSummarizerRequest } from './vendor/summaryception/connectionutil.js';
import { stripReasoningBlocks, requireModelOutput, getModelOutputIssue } from './vendor/summaryception/output-validation.js';
import { metadataSources, readMemoryMetadata, memoryTextRevision, MEMORY_METADATA_INSTRUCTION } from './vendor/summaryception/memory-metadata.js';
import { collectSummaryWorldInfo, attachSummaryWorldInfo, summaryWorldInfoBudget } from './vendor/summaryception/world-info-context.js';
import { STORY_SPINE_INSTRUCTION, storySpineSources, readStorySpine } from './story-spine.js';

const CONTINUITY = `The previous_l0 (or prior_context) is the COMPLETE immediately preceding saved L0, supplied as continuity context and a style example. Continue its narrative thread with the new source packet. Preserve necessary referents and unresolved conditions without recopying the whole previous summary. For the first packet there is no previous L0.
Only new_sources (or passage_in_question) are witnesses for this packet's new events, search excerpts and WI contributions. previous_l0 is a saved account, not an additional source handle or independent proof. Do not turn its claims into newly observed events. Preserve thoughts versus speech, plans versus outcomes, attribution, identity and limiting conditions. Do not continue the roleplay.`;
const MEMORY_ROLES = `L0 and Lprime preserve how the story reached this point: causal order, meaningful dialogue, changes in knowledge or relationships, plans versus outcomes and unresolved conditions. Keep that account understandable even if no WI is activated.
WI answers what is useful to know about one identifiable person, place, object or rule at the next encounter, including bounded current state. It is not an episode log or a substitute for narrative continuity. Do not copy the whole scene or source excerpts into entity profiles. Necessary overlap is allowed, but the two representations are not independent evidence. Out-of-character player requests are not actions or speech by a character.
Prioritize conditions that determine whether the next planned action is viable. Keep its required place, trigger, hazard and prerequisite with the action. Preserve stated quantities together with their original units, ranges and qualifiers; do not convert or reinterpret measurements. Do not merge separately stated relationships into a new causal chain. Who knows, claims or infers a fact is part of it; preserve that boundary in both narrative and profiles.`;
const DEFAULT_SYSTEM = 'You summarize roleplay for continuity. Preserve the concrete facts needed to continue correctly in compact coherent prose. Output the complete memory, not commentary.';
const DEFAULT_USER = '<player_name>\n{{player_name}}\n</player_name>\n\n<previous_l0>\n{{context_str}}\n</previous_l0>\n\n<new_sources>\n{{story_txt}}\n</new_sources>\n\nWrite the next complete L0 for these new sources.';
const unique = values => [...new Set(values)];

export function installArchiveRuntime({ ctx, settings, getArchive, saveArchive, status = () => {},
    afterSave, prepareReferences, refreshInjection: onRefreshInjection, onBusyChange = () => {},
    sendRequest = sendSummarizerRequest } = {}) {
    let job = null, timer = null, generationActive = false, historyProvider = null;
    let nativeIsGenerating = null;
    const nativeReady = import('/script.js').then(native => { nativeIsGenerating = native.isGenerating; })
        .catch(error => console.warn('[World Memory] Native generation state unavailable; using context/events.', error));
    const events = ctx().eventTypes || ctx().event_types || {}, eventSource = ctx().eventSource;
    const config = () => ({ retainedContextTokens: 8000, batchContextTokens: 24000, blindZoneExchanges: 1,
        ghostUserMessages: true, ghostAssistantMessages: true, reapplyGhostingOnSummary: false,
        summarizerWorldInfo: true, summarizerWorldInfoPercent: 20, ...settings() });
    const isGenerating = () => generationActive || Boolean(nativeIsGenerating?.())
        || (typeof ctx().isGenerating === 'function' ? ctx().isGenerating() : Boolean(ctx().isGenerating));
    const isBusy = () => Boolean(job) || isGenerating();
    const warn = message => { status(message, 'warning'); globalThis.toastr?.warning?.(message, 'World Memory'); };
    const clean = text => {
        let value = stripReasoningBlocks(text);
        for (const pattern of config().stripPatterns || []) if (pattern) value = value.replaceAll(pattern, '');
        return value.replace(/\n{3,}/g, '\n\n').trim();
    };
    const snapshot = (options = {}) => {
        const context = ctx();
        for (const message of context.chat || []) sourceId(message);
        return archiveSnapshot(getArchive(), context, options);
    };
    const historyText = () => {
        try { const text = historyProvider?.(); return typeof text === 'string' && text.trim() ? text : null; }
        catch (error) { console.warn('[World Memory] Selected history unavailable:', error); return null; }
    };
    function refreshInjection() {
        if (onRefreshInjection) return onRefreshInjection(historyText());
        void Promise.resolve(eventSource?.emit('worldmemory:injection-refresh')).catch(error => console.warn('[World Memory]', error));
        return historyText();
    }
    function stop(reason) {
        clearTimeout(timer);
        job?.controller.abort(reason instanceof Error ? reason : new Error('Stopped. Already saved packets were kept.'));
    }
    function guard(owner) {
        owner.controller.signal.throwIfAborted();
        const current = ctx();
        if (current.chat !== owner.chat || current.chatMetadata !== owner.metadata || current.chatId !== owner.chatId
            || getArchive() !== owner.archive) throw new Error('Chat or archive changed. The result was not applied.');
    }
    async function run(operation, options = {}) {
        await nativeReady;
        if (isBusy()) throw new Error('Memory or RP generation is busy. Retry after it finishes.');
        clearTimeout(timer);
        const context = ctx(), owner = { context, chat: context.chat, metadata: context.chatMetadata,
            chatId: context.chatId, archive: getArchive(), controller: new AbortController() };
        if (!owner.chatId || !Array.isArray(owner.chat)) throw new Error('Open a character chat first.');
        job = owner;
        onBusyChange();
        const abort = () => owner.controller.abort(options.signal.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        try { guard(owner); return await operation(owner); }
        catch (error) { status(owner.controller.signal.aborted ? owner.controller.signal.reason?.message || 'Stopped. Already saved packets were kept.' : error.message); throw error; }
        finally { options.signal?.removeEventListener('abort', abort); if (job === owner) job = null; onBusyChange(); }
    }
    function wait(promise, owner) {
        const signal = owner.controller.signal;
        let rejectAbort;
        const aborted = new Promise((_, reject) => {
            rejectAbort = () => reject(signal.reason || new Error('Stopped.'));
            signal.addEventListener('abort', rejectAbort, { once: true });
            if (signal.aborted) rejectAbort();
        });
        return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', rejectAbort));
    }
    async function persist(owner, reason, packetId = null) {
        guard(owner);
        await saveArchive({ archive: owner.archive, context: owner.context, signal: owner.controller.signal });
        guard(owner);
        try { await afterSave?.({ metadata: owner.metadata, reason, packetId }); }
        catch (error) { status(`Memory saved; local update needs retry: ${error.message}`); }
        guard(owner); refreshInjection();
    }
    async function transport(owner, systemPrompt, prompt, options = {}) {
        guard(owner);
        const selected = { ...config() };
        if (Number(options.responseTokens) > 0) for (const key of ['summarizerResponseLength', 'openaiMaxTokens', 'ollamaMaxTokens']) selected[key] = Number(options.responseTokens);
        let idle;
        const activity = () => {
            clearTimeout(idle);
            idle = setTimeout(() => owner.controller.abort(new Error('No response data for 120 seconds. Saved memory was kept.')), 120000);
            options.onActivity?.();
        };
        activity();
        try {
            const result = await wait(sendRequest(selected, systemPrompt, prompt,
                { signal: owner.controller.signal, returnDetails: true, onActivity: activity }), owner);
            guard(owner); return { ...result, text: clean(result.text || '') };
        } finally { clearTimeout(idle); }
    }
    const view = archive => ({ layers: [readArchive(archive)],
        legacySourceIds: unique(Object.values(archive.legacy || {}).flatMap(store => store.legacySourceIds || [])),
        skippedMessageIds: unique([...(archive.skippedMessageIds || []),
            ...Object.values(archive.legacy || {}).flatMap(store => store.skippedMessageIds || [])]) });
    async function protectBlindZone(owner) {
        guard(owner); syncContextOverrides(owner.chat);
        const boundary = blindZoneStart(owner.chat, config());
        const restore = owner.chat.flatMap((message, index) => index >= boundary && message.extra?.sc_ghosted
            && !message.extra.sc_context?.manual ? [index] : []);
        if (restore.length) { await setContextForMessages(owner.chat, restore, false); await persist(owner, 'blind-zone'); }
        guard(owner);
    }
    const orderedL0 = () => snapshot({ effective: false }).packets.filter(packet => packet.kind === 'l0').sort((a, b) => {
        const order = packet => packet.sources.length ? packet.sources[0].index
            : packet.order < Number.MAX_SAFE_INTEGER ? packet.order : packet.turnRange?.[0] ?? Number.MAX_SAFE_INTEGER;
        return order(a) - order(b) || a.id.localeCompare(b.id);
    });
    function predecessor(target = null, firstSource = Number.MAX_SAFE_INTEGER) {
        const packets = orderedL0();
        if (target) {
            const index = packets.findIndex(packet => packet.id === target.id);
            if (index >= 0) return packets[index - 1] || null;
            firstSource = target.sources?.[0]?.index ?? target.turnRange?.[0] ?? target.order ?? firstSource;
        }
        return packets.filter(packet => packet.sources.length ? packet.sources[0].index < firstSource
            : (packet.turnRange?.[0] ?? packet.order) < firstSource).at(-1) || null;
    }
    function checkPrevious(previous) {
        if (previous && readPacket(getArchive(), previous.id)?.text !== previous.text) throw new Error('The previous L0 changed. Retry with its saved revision.');
    }
    const originals = (owner, ids) => {
        const byId = new Map(owner.chat.map((message, index) => [sourceId(message), { message, index }]));
        return ids.map(id => {
            const found = byId.get(id);
            if (!found) throw new Error('A linked original source is missing. Saved memory was kept.');
            return { id, index: found.index, name: found.message.name || (found.message.is_user ? 'User' : 'Assistant'),
                isUser: Boolean(found.message.is_user), text: found.message.mes || '' };
        });
    };
    function checkSources(owner, sources) {
        guard(owner);
        if (JSON.stringify(originals(owner, sources.map(source => source.id))) !== JSON.stringify(sources)) {
            throw new Error('Original messages changed. The response was not applied.');
        }
    }
    const fingerprints = (owner, sources) => {
        const plain = captureSourceFingerprints(owner.chat, sources.map(source => source.id));
        return Object.fromEntries(sources.map(source => [source.id, `${plain[source.id]}:${memoryTextRevision(source.text)}`]));
    };
    function languageInstruction() {
        const s = config(), key = s.summaryLanguage || s.language || 'auto';
        let language = key === 'custom' ? s.summaryCustomLanguage : ({ en: 'English', ru: 'Russian', auto: '' })[key];
        if (language === undefined) {
            try { language = new Intl.DisplayNames(['en'], { type: 'language' }).of(key); } catch { language = key; }
        }
        return language ? `Write memory prose, story_spine, Lprime and search keys in ${language}. Exact source excerpts remain verbatim.` : 'Follow the new sources language; preserve exact source excerpts verbatim.';
    }
    async function references(owner, sources, existingSummary, packetId) {
        if (!sources.length || !prepareReferences) return null;
        try {
            const value = await wait(Promise.resolve(prepareReferences({ sourceIds: sources.map(source => source.id),
                existingSummary, packetId, signal: owner.controller.signal })), owner);
            guard(owner); return value;
        } catch (error) {
            guard(owner); warn(`WI references unavailable: ${error.message}. L0 can still be saved.`);
            return { failed: true };
        }
    }
    async function generateL0(owner, sources, previous, { existing = null } = {}) {
        const localSources = storySpineSources(sources), s = config();
        guard(owner); checkPrevious(previous);
        const system = [s.summarizerSystemPrompt || DEFAULT_SYSTEM, CONTINUITY, MEMORY_ROLES, languageInstruction(),
            'This is stage 1: write the complete L0 prose, followed by its story_spine. Do not emit memory_metadata, search facts or WI JSON; those are prepared separately from the saved L0 and the same originals.',
            STORY_SPINE_INSTRUCTION].join('\n\n');
        const story = localSources.map(source => `[${source.handle}] ${source.name}: ${source.text}`).join('\n\n');
        const template = s.summarizerUserPrompt || DEFAULT_USER;
        let prompt = template.replaceAll('{{player_name}}', () => ctx().name1 || 'User')
            .replaceAll('{{context_str}}', () => previous?.text || '(first L0; no previous memory)')
            .replaceAll('{{story_txt}}', () => story);
        if (!template.includes('{{context_str}}')) prompt += `\n\n<previous_l0>\n${previous?.text || '(first L0; none)'}\n</previous_l0>`;
        if (!template.includes('{{story_txt}}')) prompt += `\n\n<new_sources>\n${story}\n</new_sources>`;
        if (existing !== null) prompt += `\n\n<existing_summary>\n${existing}\n</existing_summary>\nRefine the complete existing_summary against exactly new_sources. Retain all its supported details, recover omissions and correct unsupported claims. This is a complete replacement, not a delta; do not drop facts as already known from previous_l0.`;
        if (s.summarizerWorldInfo) {
            status('Scanning native World Info for the source packet and previous L0.');
            const info = await collectSummaryWorldInfo(story, [previous?.text, existing].filter(Boolean).join('\n\n'), {
                maxTokens: summaryWorldInfoBudget(s), sourceMessages: sources.map(source => `${source.name}: ${source.text}`),
                signal: owner.controller.signal,
                onComplete: ({ partial }) => { if (partial) warn('Native WI partially included; whole entries that did not fit were omitted.'); } });
            guard(owner); prompt = attachSummaryWorldInfo(prompt, info);
        }
        status('Stage 1: waiting for L0 and its story skeleton. Stop cancels the request.');
        const response = await transport(owner, system, prompt);
        guard(owner); checkPrevious(previous); checkSources(owner, sources);
        // A provider's unsolicited service tail must not become L0 prose.
        const parsedSpine = readStorySpine(response.text, localSources);
        const marker = parsedSpine.text.indexOf('<memory_metadata>');
        const text = (marker < 0 ? parsedSpine.text : parsedSpine.text.slice(0, marker)).trim();
        requireModelOutput(text);
        const detail = { ...response, text, annotationStatus: 'pending', annotationError: null,
            storySpine: parsedSpine.storySpine ? { ...parsedSpine.storySpine, textRevision: memoryTextRevision(text),
                sourceFingerprints: fingerprints(owner, sources), sourceStatus: 'linked' } : null,
            storySpineError: parsedSpine.warning || null,
            memoryMetadata: { version: 1, textRevision: memoryTextRevision(text), lprime: null, facts: [],
                sourceFingerprints: fingerprints(owner, sources), sourceStatus: 'linked', producer: 'worldmemory-archive-prose-v1' } };
        if (Number.isFinite(detail.tokenCount)) {
            detail.responseTokenCount = detail.tokenCount; detail.responseTokenCountSource = detail.tokenCountSource;
        }
        const count = ctx().getTokenCountAsync;
        detail.tokenCount = Math.max(1, Math.ceil(text.length / 4));
        detail.tokenCountSource = 'estimated: characters / 4';
        if (typeof count === 'function') try {
            const estimate = await count(text, 0);
            if (Number.isFinite(estimate) && estimate > 0) {
                detail.tokenCount = estimate;
                detail.tokenCountSource = 'estimated: ST text counter; may use fallback';
            }
        } catch { /* A display estimate must not discard completed L0 prose. */ }
        guard(owner); return detail;
    }
    // Stage 2 shares its caller's writer/controller; it never re-enters public backfill.
    async function annotate(owner, record, sources, options = {}) {
        guard(owner);
        const before = JSON.stringify(record), localSources = metadataSources(sources);
        const savedFingerprint = snapshot({ effective: false }).packets.find(packet => packet.id === record.id)?.sourceFingerprints || {};
        try {
            const wi = await references(owner, sources, record.text, record.id);
            const system = [MEMORY_METADATA_INSTRUCTION, MEMORY_ROLES, languageInstruction(), wi?.systemPrompt,
                'This is stage 2. The saved L0 prose is immutable and is a draft navigation aid, not independent proof. Return ONLY one <memory_metadata> JSON block, with no L0 prose. Search excerpts and this packet\'s WI contributions must be supported by the supplied new_sources, not by the saved L0 or retained prior references. With no original sources use saved_summary only for Lprime, return facts: [], and omit WI claims.'].filter(Boolean).join('\n\n');
            const prompt = JSON.stringify({ task: 'Annotate this already saved L0. Do not regenerate or rewrite its prose.',
                saved_summary: record.text, source_status: sources.length ? 'linked' : 'summary-only',
                new_sources: localSources.map(source => ({ handle: source.handle, name: source.name, text: source.text })),
                ...(wi?.context ? { world_memory_context: wi.context } : {}) });
            status('Stage 2: preparing search metadata and WI for saved L0.');
            const response = await transport(owner, system, prompt, options);
            guard(owner); if (sources.length) checkSources(owner, sources);
            if (JSON.stringify(readPacket(owner.archive, record.id)) !== before) throw new Error('Saved L0 changed during annotation. Response not applied.');
            const parsed = readMemoryMetadata(response.text, localSources, { backfill: true, extractiveFacts: true });
            if (!parsed.metadata) throw new Error(parsed.warning || 'No usable metadata returned. L0 is saved; retry metadata backfill only.');
            if (parsed.warning) warn(parsed.warning);
            const metadata = { ...parsed.metadata, textRevision: memoryTextRevision(record.text),
                sourceFingerprints: sources.length ? fingerprints(owner, sources) : savedFingerprint,
                sourceStatus: sources.length ? 'linked' : 'summary-only', producer: 'worldmemory-archive-annotation-v2-source-index',
                ...(wi ? { wiRequested: true, wiContext: wi.stamp || null, wiStatus: parsed.metadata.wi ? 'generated' : 'missing' } : {}) };
            if (!sources.length) delete metadata.wi;
            const complete = !parsed.warning && Boolean(metadata.lprime?.text && (!wi || metadata.wi));
            putPacket(owner.archive, { ...record, memoryMetadata: metadata, annotationStatus: complete ? 'complete' : 'partial',
                annotationError: parsed.warning || (complete ? null : 'Some optional metadata is missing; retry stage 2 only.'),
                annotationUsage: response.usage || null, annotationTokenCount: response.tokenCount ?? null });
            await persist(owner, 'metadata-only', record.id);
            const packet = readPacket(owner.archive, record.id);
            return { packet, warning: parsed.warning || packet.annotationError };
        } catch (error) {
            // Stage 1 is already durable. Mark a retryable annotation without overwriting later edits.
            if (!owner.controller.signal.aborted && ctx().chatMetadata === owner.metadata && getArchive() === owner.archive
                && JSON.stringify(readPacket(owner.archive, record.id)) === before) {
                putPacket(owner.archive, { ...record, annotationStatus: 'pending', annotationError: error.message });
                await persist(owner, 'annotation-pending', record.id);
            }
            throw error;
        }
    }
    async function summarizeBatch(owner, force) {
        guard(owner); syncContextOverrides(owner.chat); await protectBlindZone(owner);
        const plan = await planRawContext(owner.chat, view(owner.archive), config(), () => owner.controller.signal.aborted);
        guard(owner);
        if (!plan.hasBatch || (!force && !plan.ready)) return null;
        const passage = plan.passage, sources = originals(owner, passage.sourceMessageIds);
        const previous = predecessor(null, passage.indices[0]);
        const result = await generateL0(owner, sources, previous);
        checkSources(owner, sources); checkPrevious(previous);
        const current = resolveSnippetSources(passage, owner.chat);
        if (current.indices.some(index => index >= blindZoneStart(owner.chat, config()))) throw new Error('The source packet entered the blind zone. Response not applied.');
        const record = { ...result, id: crypto.randomUUID(), kind: 'l0', sourceMessageIds: [...passage.sourceMessageIds],
            sourceFingerprints: captureSourceFingerprints(owner.chat, passage.sourceMessageIds), sourceStatus: 'exact',
            sourceFingerprintOrigin: 'generated', turnRange: [current.indices[0], current.indices.at(-1)],
            timestamp: Date.now(), previousL0Id: previous?.id || null, previousL0Revision: previous ? memoryTextRevision(previous.text) : null };
        putPacket(owner.archive, record);
        await persist(owner, 'l0-saved', record.id); // Durability precedes native hide.
        const covered = new Set(readArchive(owner.archive).flatMap(packet => packet.sourceMessageIds));
        const targets = (config().reapplyGhostingOnSummary ? owner.chat.flatMap((message, index) => covered.has(sourceId(message)) ? [index] : []) : current.indices)
            .filter(index => index < blindZoneStart(owner.chat, config()));
        if (targets.length) await applySummaryContextPolicy(owner.chat, config(), targets[0], targets.at(-1), targets);
        guard(owner); await protectBlindZone(owner); await persist(owner, 'source-context', record.id);
        try {
            const detail = await annotate(owner, readPacket(owner.archive, record.id), sources);
            status(detail.warning ? 'L0 saved; some search notes / WI are incomplete. Rebuild search notes to retry this step only.'
                : 'L0 saved; search metadata and WI stage finished.');
        } catch (error) {
            guard(owner); warn(`L0 is saved; annotation remains pending: ${error.message}. Retry metadata backfill, not L0 generation.`);
        }
        if (!readPacket(owner.archive, record.id)?.storySpine)
            warn('L0 is saved, but its compact story skeleton is missing. Prepare the missing story skeleton from the archive controls.');
        return readPacket(owner.archive, record.id);
    }
    async function summarizeNow(options = {}) {
        return run(async owner => {
            const result = { saved: 0, pending: 0, packetIds: [] };
            do {
                const packet = await summarizeBatch(owner, options.force !== false);
                if (!packet) break;
                result.saved++; result.packetIds.push(packet.id);
                if (packet.annotationStatus !== 'complete') { result.pending++; break; }
            } while (options.all && !owner.controller.signal.aborted);
            if (!result.saved) status('No source packet outside the retained raw tail and blind zone is ready.');
            return result;
        }, options);
    }
    async function rewrite(id, refine) {
        return run(async owner => {
            const record = readPacket(owner.archive, id);
            if (!record) throw new Error('The saved packet is no longer present.');
            const before = JSON.stringify(record), sources = originals(owner, record.sourceMessageIds);
            if (!sources.length || sources.some(source => !source.isUser && getModelOutputIssue(source.text))) {
                throw new Error('Valid linked originals are required. Saved memory was kept.');
            }
            const previous = predecessor(record), result = await generateL0(owner, sources, previous,
                { existing: refine ? record.text : null });
            checkSources(owner, sources); checkPrevious(previous);
            if (JSON.stringify(readPacket(owner.archive, id)) !== before) throw new Error('The saved packet changed during the request. Response not applied.');
            putPacket(owner.archive, { ...record, ...result, sourceFingerprints: captureSourceFingerprints(owner.chat, record.sourceMessageIds),
                sourceStatus: 'exact', sourceFingerprintOrigin: 'generated', timestamp: Date.now(),
                previousL0Id: previous?.id || null, previousL0Revision: previous ? memoryTextRevision(previous.text) : null,
                [refine ? 'refined' : 'regenerated']: true });
            await persist(owner, refine ? 'refined' : 'regenerated', id);
            try {
                await annotate(owner, readPacket(owner.archive, id), sources);
                status('Revised L0 and its annotations saved. Message inclusion was preserved.');
            } catch (error) {
                guard(owner); warn(`Revised L0 is saved; annotation remains pending: ${error.message}. Retry metadata backfill only.`);
            }
            return readPacket(owner.archive, id);
        });
    }
    async function backfillMemoryMetadata(options = {}) {
        return run(async owner => {
            const selected = options.packetIds || (options.packetId ? [options.packetId] : null);
            const pending = snapshot({ effective: false }).packets.filter(packet =>
                (!selected || selected.includes(packet.id)) && (options.force || packet.annotationStatus === 'pending'
                || packet.annotationStatus === 'partial' || packet.annotationError || !packet.memoryMetadata?.lprime?.text
                || packet.memoryMetadata.factMode !== 'verbatim-excerpts-v1'
                || (packet.memoryMetadata.sourceStatus === 'summary-only' && !packet.stale && packet.sourceStatus === 'linked')
                || (options.includeWI !== false && config().auto !== false && prepareReferences && !packet.stale
                    && packet.sourceStatus === 'linked' && !packet.memoryMetadata.wi)));
            const result = { saved: 0, summaryOnly: 0, warnings: 0, total: pending.length };
            for (const packet of pending) {
                guard(owner);
                const record = readPacket(owner.archive, packet.id);
                const linked = !packet.stale && packet.sourceStatus === 'linked';
                const sources = linked ? originals(owner, record.sourceMessageIds) : [];
                options.onProgress?.({ ...result, packetId: packet.id, sourceStatus: linked ? 'linked' : 'summary-only' });
                const detail = await annotate(owner, record, sources, { responseTokens: options.responseTokens, onActivity: options.onActivity });
                result.saved++; if (!linked) result.summaryOnly++;
                if (detail.warning) result.warnings++;
            }
            status(`Metadata saved for ${result.saved} / ${result.total} L0 packets. Prose was preserved.`);
            return result;
        }, options);
    }
    async function backfillStorySpine(options = {}) {
        return run(async owner => {
            const selected = options.packetIds || (options.packetId ? [options.packetId] : null);
            const pending = snapshot({ effective: false }).packets.filter(packet => !packet.stale && !packet.manual
                && (!selected || selected.includes(packet.id)) && (options.force || !packet.storySpine
                    || (packet.storySpine.sourceStatus === 'summary-only' && packet.sourceStatus === 'linked')));
            const result = { saved: 0, summaryOnly: 0, total: pending.length };
            for (const packet of pending) {
                guard(owner);
                const record = readPacket(owner.archive, packet.id), before = JSON.stringify(record);
                const linked = packet.sourceStatus === 'linked';
                const sources = linked ? originals(owner, record.sourceMessageIds) : [];
                const cells = storySpineSources(linked ? sources : [{ id: record.id,
                    name: 'Earliest saved summary; original messages unavailable', text: record.text }], { summaryOnly: !linked });
                options.onProgress?.({ ...result, packetId: packet.id, sourceStatus: linked ? 'linked' : 'summary-only' });
                const system = [STORY_SPINE_INSTRUCTION, MEMORY_ROLES, languageInstruction(),
                    'BACKFILL OUTPUT OVERRIDE: return ONLY the <story_spine> block. Do not output or rewrite L0 prose. The saved L0 is immutable. Cover every supplied handle once, in order. If these are saved-summary parts, preserve their uncertainty and do not invent original chat evidence.'].join('\n\n');
                const response = await transport(owner, system, JSON.stringify({ task: 'Build the missing story skeleton only.',
                    saved_summary: record.text, source_status: linked ? 'linked' : 'summary-only',
                    sources: cells.map(cell => ({ handle: cell.handle, name: cell.name, text: cell.text })) }), options);
                guard(owner); if (linked) checkSources(owner, sources);
                if (JSON.stringify(readPacket(owner.archive, packet.id)) !== before) throw new Error('Saved L0 changed during skeleton preparation. Response not applied.');
                const parsed = readStorySpine(response.text, cells, { backfill: true, savedText: record.text });
                if (!parsed.storySpine) throw new Error(parsed.warning || 'No usable story skeleton. Saved L0 is unchanged.');
                putPacket(owner.archive, { ...record, storySpine: { ...parsed.storySpine,
                    sourceFingerprints: linked ? fingerprints(owner, sources) : {}, sourceStatus: linked ? 'linked' : 'summary-only' },
                    storySpineError: null, storySpineUsage: response.usage ?? response.usageMetadata ?? null,
                    storySpineResponseTokenCount: response.tokenCount ?? null,
                    storySpineResponseTokenCountSource: response.tokenCountSource ?? null });
                await persist(owner, 'story-spine', record.id);
                result.saved++; if (!linked) result.summaryOnly++;
            }
            status(`Story skeleton saved for ${result.saved} / ${result.total} L0 packets. L0 text and search notes were kept.`);
            return result;
        }, options);
    }
    async function edit(id, text) {
        return run(async owner => {
            const record = readPacket(owner.archive, id);
            if (!record) throw new Error('The saved packet is no longer present.');
            const value = String(text).trim();
            if (!value) throw new Error('Memory text is empty. Use Delete to remove the record.');
            if (value === record.text) return record;
            const tokenCount = await wait(owner.context.getTokenCountAsync(value, 0), owner);
            guard(owner);
            putPacket(owner.archive, { ...record, text: value, tokenCount, tokenCountSource: 'estimated: ST text counter; may use fallback', manual: true,
                tokenCountOrigin: 'manual-tokenizer', memoryMetadata: null, annotationStatus: 'pending', annotationError: null,
                storySpine: null, storySpineError: 'Saved L0 text was edited. Manual text remains authoritative.' });
            await persist(owner, 'edited', id);
            status('Text saved. Source links are unchanged; prepare search metadata when ready.');
            return readPacket(owner.archive, id);
        });
    }
    async function remove(id) {
        return run(async owner => {
            const packet = readPacket(owner.archive, id);
            if (!packet || !deletePacket(owner.archive, id)) return false;
            await persist(owner, 'removed', id);
            const covered = new Set(readArchive(owner.archive).flatMap(item => item.sourceMessageIds));
            syncContextOverrides(owner.chat);
            const restore = owner.chat.flatMap((message, index) => packet.sourceMessageIds.includes(sourceId(message))
                && !covered.has(sourceId(message)) && message.extra?.sc_ghosted && !message.extra.sc_context?.manual ? [index] : []);
            if (restore.length) { await setContextForMessages(owner.chat, restore, false); await persist(owner, 'source-context', id); }
            return true;
        });
    }
    async function restoreStaleSources() {
        const context = ctx(), chat = context.chat, metadata = context.chatMetadata;
        if (!context.chatId || !Array.isArray(chat)) return;
        const current = snapshot({ effective: false });
        const covered = new Set(current.packets.filter(packet => !packet.stale).flatMap(packet => packet.sourceMessageIds));
        const stale = new Set(current.packets.filter(packet => packet.stale).flatMap(packet => packet.sourceMessageIds));
        syncContextOverrides(chat);
        const restore = chat.flatMap((message, index) => stale.has(sourceId(message)) && !covered.has(sourceId(message))
            && message.extra?.sc_ghosted && !message.extra.sc_context?.manual ? [index] : []);
        if (!restore.length) return;
        await setContextForMessages(chat, restore, false);
        if (ctx().chat !== chat || ctx().chatMetadata !== metadata) throw new Error('Chat changed during source context restoration.');
        await saveArchive({ context });
        refreshInjection();
    }
    function schedule() {
        clearTimeout(timer);
        if (!config().enabled || config().pauseSummarization || config().archiveAuto === false) return;
        timer = setTimeout(() => {
            if (isBusy()) return;
            const reply = ctx().chat.findLast(message => !message.is_user && !message.is_system);
            if (reply && !getModelOutputIssue(reply.mes, reply)) {
                void summarizeNow({ all: true, force: false }).catch(error => status(error.message));
            }
        }, 600);
    }
    const listen = (event, callback) => { if (event) eventSource?.on(event, callback); };
    listen(events.MESSAGE_RECEIVED, schedule);
    listen(events.GENERATION_STARTED, (type, _options, dryRun) => {
        if (type === 'quiet' || dryRun) return;
        generationActive = true; stop(); onBusyChange();
    });
    listen(events.GENERATION_ENDED, () => { generationActive = false; schedule(); onBusyChange(); });
    listen(events.GENERATION_STOPPED, () => { generationActive = false; stop(); onBusyChange(); });
    listen(events.CHAT_CHANGED, () => { generationActive = false; stop(new Error('Chat changed. Already saved packets were kept.')); refreshInjection(); });
    for (const event of [events.MESSAGE_EDITED, events.MESSAGE_SWIPED, events.MESSAGE_DELETED].filter(Boolean)) listen(event, async () => {
        stop(new Error('Chat sources changed. Already saved packets were kept.')); refreshInjection();
        try { await restoreStaleSources(); }
        catch (error) { status(error.message); }
        status('Chat sources changed. Regenerate affected saved L0 packets; original archive records remain available.');
    });
    return Object.freeze({ version: 'archive-v1', protocol: 1, snapshot, isBusy, historyText, refreshInjection,
        setHistoryProvider(provider) { historyProvider = typeof provider === 'function' ? provider : null; },
        request: (system, prompt, options = {}) => run(owner => transport(owner, system, prompt, options), options),
        backfillMemoryMetadata, backfillStorySpine, summarizeNow, regenerate: id => rewrite(id, false), refine: id => rewrite(id, true), edit, remove, stop, restoreStaleSources });
}
