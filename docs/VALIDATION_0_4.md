# 0.4.0 preview: measured scope / что проверено

Memory prompts, L0 preparation and search annotations were developed and tested with **Sol 6.1**. Another summarizer can follow them differently. Retrieval coverage and actual RP response quality are separate measurements.

## Preparation and integration

- Existing automated checks: **16/16 pass**, including the six approved outline scenarios. An independent clean Sol 6.1 high audit found no remaining P1; three P2 findings about completeness labels, unknown ordering and cancellation were corrected and reviewed.
- Two private archives: **52 and 7 L0 packets**, with **213 and 119 sources**. All 59 saved outlines parse and remain bound to their existing sources. Backfill preserves L0 and originals.
- On the reference counter, formatted outlines occupy about **5,070 and 834 tokens**, versus **64,863 and 7,195** for their L0 prose. These are corpus-specific estimates, not provider billing tokens or universal size ratios.
- Four saved malformed metadata outputs were recovered using narrow framing rules without rewriting their text or making replacement calls.
- Structural coverage does not prove semantic completeness. Review found two inaccurate/incomplete outlines; source material remains available. Do not treat generated outlines as exact evidence when the original is present.

## Optional outline-vector ranking

**240 assemblies / 120 matched pairs**, using existing player posts and triples at nominal 24k/32k envelopes. Both arms retained the same full outline; only the order of the same original candidates changed. Google `gemini-embedding-001`, 768 dimensions; existing original/query vectors were reused. No generative calls were needed for this retrieval comparison.

**Four support observations improved, one worsened: net +3 by case count.** These include different magnitudes of support change; this is neither a +3-point score nor an RP win rate. Full original-witness presence improved in four observations without a loss. New outline paraphrases were not credited as exact witnesses. Previously inspected query sets are not a blind holdout.

All assemblies exceeded their soft envelope by a final whole window; the maximum excess was **1,231 reference tokens**. The fixed triples criterion of 16/20 was not reached. Context is retained with warnings rather than clipped. The 20% virtual WI reserve belongs to this history-only experiment; it is not a global WI cap enforced on ordinary ST replies.

The optional ranking control is **off by default**. Actual-model comparisons must assess whether the supplied evidence improves the reply, independently of the positional proxy score.

## Product boundaries / границы

The entire available L″ stays in history-enabled prompts; missing/stale/manual legacy material is labelled. Unknown original order is not presented as proven chronology. Max history and full-prompt targets remain soft; native ST/provider context limits still apply.

API embeddings are the default. Local-model phone/Termux qualification is deferred and is not required to try this preview. Private cards, chats, source texts and test answers are not distributed in this repository.
