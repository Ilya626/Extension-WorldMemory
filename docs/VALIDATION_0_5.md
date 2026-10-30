# 0.5.0 preview: measured scope

0.5.0 adds optional source-bound NPC information events and an optional local evidence graph. **Both controls default to off.** The growing L0 archive, complete available L″ and normal history retrieval remain unchanged; [0.4.0 outline/retrieval measurements](VALIDATION_0_4.md) describe that earlier work.

Background prompts were developed and tuned primarily with **Sol 6.1** (`gpt-6.1-sol`); the reply comparisons used **Flash 3.8**. These results do not establish universal prompt compliance or RP quality across models.

## Limited reply comparison

The comparison covered **18 player posts**, each assigned three conditions: ordinary memory, direct information events, and events plus the local graph. That is **54 condition slots / 45 unique reply outputs**. Some identical requests reused saved replies; slots are not independent new generations. Preparation used **5 Sol requests**, followed by **33 new Flash requests**.

Results were **mixed**. Individual outputs changed in useful and unhelpful ways, and a neutral assessment did **not establish an overall RP improvement from the graph**. Automatically prepared events contained attribution/modality defects; source binding alone did not make their interpretation correct. The graph was evaluated with those prepared events, rather than silently replacing them with corrected evidence.

This was a limited, frozen comparison with prepared inputs. It does not prove that a fully automatic live queue, a cold archive or every native WI selection path behaves identically. Retrieval coverage, correct evidence delivery and better gameplay are separate outcomes.

## Narrow native acceptance

A separate isolated SillyTavern run used **3 Sol preparation requests + 2 Flash replies**. The ordinary second-stage path created **4 managed character profiles and 3 accepted source-backed events**. These persisted after reload, and the optional evidence was confirmed in an actual Flash request. Event rows and character inventories were not manually authored for this acceptance.

The archive packet for explicit preparation was selected manually. An additional preparation request was needed to establish managed profiles before event preparation could reference them. This supports the documented **profiles first, then explicit event preparation** workflow; it is not proof of automatic two-pass onboarding or the complete automatic queue.

The final two prompt-delivery guards received code review after this native run; the full native sequence was not repeated after those guards. Existing automated checks passed **20/20** during development, but that count is not comprehensive new-feature coverage.

This acceptance establishes limited preparation, persistence and delivery. It does **not** qualify every WI filtering/regex/depth combination, conventional backend authorization configuration, physical-phone behavior, non-Chat-Completion injection or general RP quality. A narrow successful request is not a quality benchmark.

## Backup and branch identity preservation

A separate native **portable export → import → new chat branch → reload** round trip verified the fix for managed character identity bindings. All **3 information events and 7 L0 packets with their outlines** remained available after the transfer and reload, without model requests. This checks identity preservation across that path; it does not establish the complete automatic preparation queue or automatic cold-archive onboarding.

## Automatic background queue and native backend

A separate full-archive operational check imported **228 original messages/sources and 52 L0 packets/outlines**, then confirmed source text, membership, stored history and reload preservation. Ordinary RP generation triggered two new background packets automatically: **52 → 54**. No manual summarize/backfill command created those packets. Before each second-stage request, the new L0 and outline were independently read from the saved native chat.

The second new packet initially became partial because the model returned its navigation prose as a plain string. After the parser compatibility fix, **one explicit metadata-only retry** returned that same format successfully: the original navigation string was preserved, the packet became complete, and valid excerpts/WI/events were retained. The L0 stage was not repeated. Existing history and source links remained unchanged; archive/WI persisted across reload. Both new packets were complete at the end.

This check used **5 Sol requests and 2 Flash replies** through the standard ST Custom backend and its localhost generation endpoint, with authorization supplied only in memory. It qualifies that header-override path, not every saved-secret/profile configuration. The raw observations include earlier unsuccessful harness sends and the partial result; they were not silently counted as successful comparisons.

For a short operational check, source/retention thresholds were temporarily reduced on the private copy, then restored. This demonstrates automatic scheduling, save-before-annotation and continuation on a real archive; it is not default-threshold load testing, a full-archive semantic review, automatic two-pass onboarding or an RP-quality benchmark. No physical-phone claim follows from it.

## Runtime boundaries

- Events record **direct observation** (`observed`) or **receipt of a statement** (`reported`). Receipt is not truth or belief; absence is not ignorance. The GM retains access to secrets and the full chronology.
- Code binds exact quotations to original ranges/revisions and managed character instances. This checks provenance, not the model's interpretation. Changed, hidden or unavailable evidence can invalidate derived events. Original/manual WI is preserved; previous experimental epistemic rows remain legacy data.
- The optional graph runs locally with **0 LLM calls**, linking actors, original messages and exactly matching topics. Shared links and acquaintance do not transfer knowledge.
- Normal ready-packet preparation remains **2 sequential background generation requests**: L0/L″ first, then search metadata/WI plus enabled events. Existing archives require explicit second-stage preparation; no permanent third call or per-RP-turn LLM call was added.
- New event-context injection requires **Chat Completion** and follows final native WI activation. A final rendered-text check can withhold the addition when a selected profile is absent; it is not UID tracing through arbitrary third-party transformations.
- The addition shares **ST's total input context**. Its cap is **12,000 characters in whole rows**, not a token allowance. Oversized graph views fall back to direct events. The default 24k budget illustration excludes this disabled addition; actual model context and output reserve remain ST/provider settings.

Private names, plots, quotations, character cards, chats, credentials and evaluation artifacts are not distributed with this public report. [Setup and explicit archive preparation](../README.md#optional-npc-information-events) · [Reference](REFERENCE.md#optional-information-events-and-local-graph).
