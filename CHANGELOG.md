# Changelog

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
