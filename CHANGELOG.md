# Changelog

## 0.5.1 — 2026-10-31 — portable memory in character cards

- Add **Portable backup → Save memory to card / Read memory from card**. Store an explicit `world-memory-v1` snapshot in `data.extensions.worldMemoryBackup`, preserved by native PNG/JSON card export. Include L0, available L″, archived originals, search metadata and the managed WI book; keep author lore and other card fields.
- Replace the previous card snapshot exactly, without deep-merging removed archive records. Read through the existing guarded backup importer; no automatic overwrite, model requests, API credentials or connection settings.
- Keep the ongoing ST chat and recent raw tail as a separate chat export. Card reading restores memory for the open chat, not the live conversation.
- Preserve the original file-import receiver reservation before asynchronous file reading.

## 0.5.0 — 2026-10-31 — optional NPC information events

- Add optional source-bound `observed` / `reported` events to the existing second-stage search-metadata / WI response. Keep the growing L0 archive, complete L″, normal retrieval and two-call background packet flow unchanged.
- Add separate GM evidence for eligible managed character profiles selected by native WI, with native regex/depth handling and a final rendered-profile presence check. The new injection requires Chat Completion; other API modes keep stored events without injecting them.
- Add an optional local graph of actors, original messages and exactly matching topics. It adds related evidence with no extra LLM calls or embedding model. **Event tracking and the graph both default to off.**
- Keep whole evidence rows within a 12,000-character cap, falling back from an oversized graph to direct events. This is part of ST's total context, not a token allowance. Default 24k prompt examples exclude the disabled addition.
- Preserve original/manual WI and previously stored experimental epistemic rows as legacy. Old archives require explicit second-stage preparation; archives without managed character profiles need WI profiles first, then explicit event preparation. Automatic two-pass onboarding is not claimed.
- Preserve managed character identity bindings when importing a portable backup or creating a chat branch. A native export → import → branch → reload round trip retained all 3 information events and 7 L0 packets/outlines without model requests.
- Accept navigation prose returned as a plain `lprime` string with an empty keyword list. Preserve its text and keep exact-source excerpt and WI validation unchanged, avoiding a needless partial result for this format variation.
- Verify the native automatic background queue on an imported 228-message, 52-packet archive: two new packets were saved before their annotation calls. A separate metadata-only retry confirmed recovery of the plain-string navigation format without regenerating L0. [Scope and limits](docs/VALIDATION_0_5.md#automatic-background-queue-and-native-backend).
- Document the mixed 18-post comparison and narrow native preparation/reload/delivery acceptance. No overall RP benefit, universal model quality, physical-phone or full authorization-mode qualification is claimed. [Measured scope](docs/VALIDATION_0_5.md).

## 0.4.0 — 2026-10-30 — complete story outline preview

- Keep the entire available chronological L″ in the history prompt. Independently retrieved original windows follow their matching outline steps; selection never replaces those steps.
- Generate one short packet outline alongside each new L0. Prepare missing outlines explicitly from saved L0 without rewriting it; preserve valid L0 when optional metadata fails.
- Keep manual text and labelled legacy fallback. Mark missing, stale and unknown-order material rather than claiming complete chronology.
- Add optional bounded outline-vector ranking, disabled by default. Reuse query vectors and cache outline vectors; add no generative call per RP turn.
- Document the separate history/raw-tail budgets, soft overflow, installation and measured preview limits. API embeddings remain the default; phone-local model qualification is deferred.

## 0.3.3 — 2026-10-30

- Keep a manually edited WI record's source links when reapplying saved WI. Actual source removal or invalidation still retracts the affected links; manual text remains untouched.

## 0.3.2 — 2026-10-30

- Recover a search excerpt when the model added an outer `*`: accept only a uniquely located original substring in the cited message, retaining its original text and offsets. Source handles, spelling and internal text are not corrected. Saved L0 and WI are unchanged.

## 0.3.1 — 2026-10-30

- Preserve disabled history when migrating from the pre-standalone extension: translate it to the current **Off — do not send history** control, without overwriting an existing insertion choice. Off also stops requesting hidden search hints. Missing settings still receive the new defaults.

## 0.3.0 — 2026-10-30 — standalone preview

- Run WorldMemory without Summaryception. Keep a growing, source-linked L0 archive and import supported legacy memory without running layer transfers.
- Save L0 before the separate search-note / WI stage. New L0 uses the complete chronological predecessor for continuity; failed annotation can be retried without regenerating the saved L0.
- Retrieve original history with keyword and API embedding search. New installations use API embeddings by default; existing settings are preserved. Local embeddings remain optional.
- Separate the recent raw tail from the soft retrieved-history target. Defaults are 8,000 tokens each, with a 24,000-token source packet and one protected recent exchange.
- Maintain entity references in a separate native WI book. Keep native activation, positions and budgets; optional semantic WI and Russian WI Forms supplement ordinary keywords.
- Keep manual visibility and record edits. Changed sources retain their saved L0 for review while stale automatic contributions are retracted.
- Use one summarizer connection and streaming choice for background operations, with idle-timeout handling and Stop support.
- Add portable archive/WI backups, clearer connection controls, English and Russian instructions, and optional local-model launchers.

Model output can still omit details, confuse identities or end before completing metadata. Original messages and saved L0 remain available; inspect warnings and rebuild search notes / WI when needed. Universal retrieval quality and local Gemma on real Termux are not claimed for this preview.
