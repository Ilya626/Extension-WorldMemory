# WorldMemory reference

[Quick start](../README.md) · [Русский](REFERENCE_RU.md) · [0.5.0 validation](VALIDATION_0_5.md) · [Local embeddings](LOCAL_EMBEDDINGS.md)

## What is saved

Each new packet follows two requests through the summarizer connection:

1. **Stage 1:** generate L0 prose and its short chronological **L″ outline** from this packet's original messages and the **complete immediately preceding L0** (`previous full L0`), then save the new L0 durably. The predecessor supports continuity; its events must not be copied into the new packet. Code assigns outline source links and order. A malformed optional outline leaves the valid L0 saved. The growing archive retains individual packets rather than merging them into higher layers.
2. **Stage 2:** annotate the saved L0 using the same original sources. Save a short **L′** navigation thread, exact source excerpts (`facts`), optional WI updates and, when enabled, optional **information events** in the same metadata response. Code assigns source addresses and text spans. New evidence must come from the packet's originals, not merely from the summary or prior references. There is no permanent third generation request.

Active native WI can be supplied read-only to both stages under **Summarizer connection → Advanced summarizer context**. The managed UID/reference catalogue also includes inactive entries, so a record need not be activated in the current prompt to be found and updated as an existing subject. Existing references help identify subjects; they do not prove new events.

If stage 2 fails, the saved L0 stays available and its annotation is marked pending/partial. Retry that step rather than paying to regenerate correct prose. Applying a saved WI result is local and needs no model request. **Stop** cancels current work while retaining completed saves.

**Summarizer connection → Advanced summary prompts** lets you edit migrated or custom L0 instructions. Blank fields use the built-in prompts. In the user template, `{{story_txt}}` is the new source packet, `{{context_str}}` is the complete previous L0, and `{{player_name}}` is the player name. These settings do not change the separate search-note / WI format.

Example: a workshop keeper lends a visitor a key until morning. L0 preserves the conversation, event order and time condition. WI describes the keeper, workshop and relevant relationships as reusable entity reference. A promise, attempt and completed action remain different facts.

## Edit and recover saved packets

**Advanced history and packet settings → Let replies add hidden search hints** controls the optional cue requested after new chat replies. It stores a brief scene anchor, keywords and an unfinished condition with that reply, for later source-linked search. It uses the same model response and is separate from background L0 annotation; old messages work without it. Editing or switching the reply invalidates a cue that no longer matches its text.

Expand a packet in **L0 archive**:

| Control | Result |
| --- | --- |
| **Save text** | Save your edited L0 without a model request. Keep source links; invalidate old search/WI annotation and mark it pending. |
| **Regenerate** | Generate a replacement from that packet's linked sources and its chronological predecessor, then run stage 2. |
| **Refine** | Supply the existing L0 as well as those sources and predecessor to produce a complete revised L0, then run stage 2. |
| **Prepare / Rebuild story skeleton** | Generate this packet's short L″ from saved L0, preserving L0 prose and original source links. Manual or stale records are not silently rewritten. |
| **Rebuild search notes / WI** | Explicitly rerun stage 2 for this packet, including one whose annotation was already completed; preserve its L0 prose. |
| **Delete** | Remove the saved packet from active use and retract its automatic contributions. Original chat messages remain. |

**Prepare missing search notes / WI** resumes incomplete or missing annotations across saved packets, without rewriting their prose. It may make one model request for each packet needing preparation. With unavailable originals it can create only a summary-based L′, without invented source excerpts or new WI claims.

Your edited L0 remains a separately labelled search candidate. Saved summaries without original messages are searchable too. Selection follows relevance and the history token budget.

**Prepare missing story skeleton** prepares absent outlines across eligible archive packets, one summarizer request per packet. Existing valid outlines are reused. Backfill sees the saved L0, so it cannot recover a detail already omitted from that account. Editing L0 invalidates its derived outline; changes to originals mark it stale. Missing outlines retain labelled full L0; unknown original order is explicitly marked.

Search notes use brief scene labels and source-specific keywords with exact excerpts. They guide retrieval of the originals; source coverage and a ready status do not guarantee that every detail will be selected for a reply. Updated instructions apply when notes are next generated; existing notes remain saved.

Editing, swiping or deleting linked chat messages invalidates affected retrieval evidence. The saved account is retained but excluded from retrieval while stale. Use **Regenerate** for the affected packet and review any missing originals; it uses that packet's remaining linked source set, not arbitrary neighbouring messages.

## History and prompt size

Before the next reply, the latest player post independently searches earlier sources. L′ and search keys help locate them. The entire available L″ stays in the prompt, with selected exact original windows added immediately after their matching outline step. Overlapping windows merge; compact steps are never replaced by hits. User-edited and source-less memories carry explicit labels. L′ remains a search aid in the archive. Restoring an excerpt does not mean the whole episode was recovered.

**Max history tokens (soft target)** shares its default 8,000 tokens between the full outline, its labels and retrieved originals. Whole retained fragments or the outline itself can exceed it with a warning; it is not a truncation limit on saved L0. **Raw tail** independently retains recent messages. **Advanced history insertion** controls history position, role, depth, wrapper and whether native WI may scan it. Setting history insertion to Off disables this history prompt, including the outline. WI has its own insertion controls.

**Full RP prompt target (tokens)** defaults to 24,000 for the complete input: system/card, WI, history, raw tail and current post, plus optional information-event context when enabled and delivered. It is a size reference, not a hard cap enforced on ST's complete request. The default [24k example](../README.md#prompt-fill-bar-defaults-and-controls) excludes the disabled information-event addition. Enabling it adds to the total native ST context; its 12,000-character cap is not a token budget or reserved allowance. Check the prompt-size display and actual assembled prompt.

The optional **Let replies add hidden search hints** setting adds a short service block to the regular RP response, without another generation request. Hints belong to the selected swipe and are search suggestions, not world facts. The reader uses a hint only to rank its unchanged original; hint text is never inserted as history. Missing hints never reject the reply.

## Search and embeddings

Keyword history search works without embeddings. Optional [Russian WI Forms](https://github.com/Ilya626/Extension-RussianWI) supports Russian dictionary forms: an ordinary key such as `меч` can match `мечом`. These keys and their native activation remain independent of semantic search.

Open **Search and embeddings**. **Search history by meaning (embeddings)** enables semantic history retrieval. **World Info · entity reference → Also find WI by meaning** separately enables semantic WI. Both use the same **Embedding connection**, while their indexes and selected results stay separate.

New installations enable semantic history search with **API embeddings**, Google **`gemini-embedding-001`**, **768 dimensions**, **Google / Gemini embeddings** format. Existing saved settings are preserved. Set **API URL** and **API key** here; blank values inherit WorldMemory's OpenAI-compatible summarizer URL/key. For a current ST connection, Connection Profile or Ollama summarizer, enter embedding credentials explicitly. **API format** also offers OpenAI-compatible embeddings when supported by the provider. Google-native requests use `x-goog-api-key`. ST Vector Storage settings are not used.

Changed sources are indexed as needed; unchanged vectors and queries are reused. IndexedDB is a derivative cache, with RAM fallback. API and local profiles keep separate caches. Embedding failures leave keyword search available. No separate generative search request or mandatory reranker is needed for every player post.

**Experimental outline ranking** is disabled by default. When enabled, cached outline vectors refine the existing candidate order in groups of four, moving a candidate at most three positions. Query vectors are reused. Source addresses bind each score to its actual window; time order is not inferred from vector coordinates. The method neither gates search to one scene nor adds a recency bonus. Failure retains the ordinary ranking; cancellation retains the already published baseline. [Preview validation](VALIDATION_0_4.md).

With **Google / Gemini embeddings**, Gemini Embedding 2 model names automatically use the model's textual search instructions. Use the exact model ID supported by your provider; changing models creates a separate vector space and index. The default remains `gemini-embedding-001`. See [Google's embedding instructions](https://ai.google.dev/gemini-api/docs/embeddings).

Storage recovery is automatic. If browser storage fills, WorldMemory can remove cached vectors from other embedding profiles before saving the current result. Returning to an evicted profile can require indexing again. Storage failures use RAM and retry persistence on later work; saved messages, memory and WI are retained.

**Search and embeddings → Embedding cache → Clear embedding cache** removes derived vectors only. Messages, saved L0 and WI remain intact; subsequent searches rebuild the vectors.

## Native WI and manual control

Generated WI uses a separate native, chat-scoped lorebook. Existing author books and their bindings stay intact. Main profiles use **Constant** by default; other entries use ordinary keys. The default generated-entry position is **In chat at depth**, depth **2**. Change it under **Advanced WI writing and insertion**. Constant still follows ST's budget.

Set the WI budget for game replies in **ST's World Info settings**. WorldMemory's **Advanced summarizer context → WI context allowance** controls reference context for background requests; its default is 20% of **Source packet (tokens)**.

For a reply, Constant and keyword/Russian-form matches provide the native reference set; optional semantic matches add candidates to the same ST scan. This does not reserve a separate budget priority for keyword matches. For background updates, the writer receives the saved L0 and its originals, a catalogue of all managed profiles (including inactive ones), and optional read-only author WI found by native scanning. It updates entity references from these sources; it does not turn the selected WI into another episode summary.

Semantic WI adds **one extra temporary primary key** to each selected eligible entry. Replies search the current player post; background author-WI scans search bounded windows of their selected historical sources. A temporary key matches only a scan containing its source window. It can add **one point to native group scoring**. ST still evaluates secondary-key conditions, disabled flags, groups, budgets and insertion positions. Saved keys/books are unchanged. There is no core patch or FORCE activation. This is an additional activation reason, not a guarantee that an entry enters the prompt.

Use **Characters** / **Other records and sources** to inspect records. **Keep manual** protects an entry; edits to generated title, keys, text, Constant or disabled state are also detected. **Allow automatic updates** opts it back in. Manually added native entries remain outside automatic ownership.

**Apply saved WI** retries local application without a model request. **Update legacy WI** explicitly runs the older model-based extraction path and can incur additional requests. Source deletion or revision retracts affected automatic evidence; retained contributions and manual records are preserved. An inactive UID still exists and can be referenced for maintenance; absence from the current prompt does not mean deletion.

Editing an archived source keeps its L0 marked **SOURCES CHANGED**. Sources without another current L0 are unhidden if they were hidden automatically; affected automatic WI contributions are removed locally, including when automatic WI writing is off. Manual visibility and WI edits are kept. Regenerate the affected L0 to refresh its saved memory.

## Optional information events and local graph

**World Info · entity reference → Track NPC information events (experimental)** defaults to off (`knowledgeBoundaries: false`). **Include related source evidence (local graph, experimental)** is separate and also off (`awarenessGraph: false`); it needs event tracking enabled. These additions leave the growing archive, full L″ and ordinary retrieval unchanged.

The existing stage-2 response can return an `awareness` array containing `observed` (direct perception) or `reported` (receipt of a statement) events. Each event names eligible managed character references, one precise topic, an exact original quotation and one source handle; a report may identify its established speaker. Code binds it to a unique original range/revision and a persisted character instance. Source edits, hidden/unavailable originals, changed L0 and deleted/reused character identities can invalidate it. Unresolved recipients are omitted. An empty array is valid; missing or unsupported output preserves saved L0 and valid search/WI data.

A report does not establish truth or belief. Absence does not establish ignorance. Later original dialogue can establish discovery. The GM retains the whole story and secrets. Exact source binding establishes provenance, not semantic correctness. Previously stored experimental `epistemic` rows remain readable as legacy data; new preparation requests the simpler events.

### Prepare an existing archive

1. Configure ordinary **Prepare and apply WI after saving L0** and enable event tracking. Event preparation needs the packet's original sources and character identities already managed at the start of the request; author WI is not guessed into that catalogue.
2. If managed character profiles are missing, first prepare/apply ordinary search notes / WI for the relevant archive. A request that creates a profile cannot also use it as a pre-existing event identity.
3. Explicitly run **Rebuild search notes / WI** on the relevant packets after profiles exist. **Prepare missing search notes / WI** is suitable for pending packets; a completed annotation may require **Rebuild**. Each selected packet can incur a stage-2 summarizer request, preserving L0. **Apply saved WI** only applies saved results locally and does not generate events.
4. Use **Chat Completion** for RP and let native WI select the profiles. Inspect the assembled prompt or `WorldMemory.inspectKnowledge()`; enable the local graph separately to compare related evidence.

There is no automatic two-pass cold-archive onboarding guarantee. Ordinary newly ready packets still use two sequential background generation requests; additional explicit preparation of older packets is separate.

### Selection, context size and delivery

The new GM addition uses the **final native WI activation set**, after keyword/Constant selection, groups, probability and budget. Native WI regex/depth rules and parameter rendering apply. Only eligible selected managed profiles establish focus; loaded candidate entries alone do not. Evidence is a separate non-scannable extension prompt, leaving original/manual WI text and saved keys intact. ST counts this addition with the other parts of the input.

The local graph links events through actors, original messages and exactly matching topics, optionally adding related source evidence. Acquaintance and shared links never establish knowledge transfer. It needs no graph database, extra embedding model or LLM request per RP turn. Its general RP benefit has not been established.

The addition is capped at **12,000 characters**, preserving whole event rows. If the graph view exceeds the cap, it falls back to direct events and prefers recent whole rows in source order. No token allowance is promised. The cap does not shorten the saved archive or L″.

The final **Chat Completion** hook checks rendered profile text and actual addition presence after prompt assembly. If a selected profile is absent, the optional addition is withheld. `WorldMemory.inspectKnowledge()` exposes preparation, selection and delivery diagnostics. This is a rendered-text check, not a native UID trace through every third-party transformation. Other API modes retain the journal without this new injection. A narrow native run verified preparation, persistence and delivery; all WI filtering modes, conventional authorization settings, physical-phone behavior and general RP quality remain outside that acceptance. [Technical boundaries](KNOWLEDGE_BOUNDARIES.md) · [0.5.0 measured scope](VALIDATION_0_5.md).

## Backups and preview limits

**Portable backup → Export backup** includes the archive, source links and managed WI state/book. Also export the ST chat to retain its original messages and swipes. A native lorebook alone cannot restore the history. **Import backup** replaces the receiving chat's saved WorldMemory content; export its current state first. Foreign-chat WI becomes protected manual records, and source availability must be reviewed. Branches/copies detected with a different chat ID get a separate book.

Review important L0 and WI results: model output can omit details or confuse identity, attribution and conditions. Incomplete search notes / WI can be rebuilt without regenerating the saved L0. Retrieval quality depends on the chat, query and models; this preview does not promise complete recall across every game. Local Gemma on real Termux will be qualified separately.

License: [AGPL-3.0](../LICENSE). Bundled Summaryception code retains its [vendor license](../vendor/summaryception/LICENSE).
