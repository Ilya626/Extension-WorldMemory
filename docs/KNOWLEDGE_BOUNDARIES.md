# Experimental NPC knowledge boundaries

This development feature adds source-linked knowledge hints to active managed character profiles. Enable **World Info · entity reference → Track NPC knowledge boundaries (experimental)**. The default is off. This document describes the implementation; measured gameplay results are reported separately.

The existing second background preparation request can return sparse knowledge changes alongside search notes and WI. The first L0/outline request stays unchanged. Each accepted change names a provided character reference, one precise topic, a state and an exact source quotation. States distinguish explicit ignorance, receipt of a claim, suspicion, belief and supported knowledge. No record is invented simply because the archive lacks evidence of awareness.

Code binds quotations to original message ranges/revisions and the character to a persisted instance in the managed WI entry. Reusing a deleted native UID does not reuse the old character instance. An exact quote establishes provenance; it does not prove that the model interpreted that quote correctly.

Before native WI activation, current source-supported hints are appended to scan-local copies of eligible profiles. Original author/manual content and keyword/Constant rules remain intact. The extra text consumes native WI space. It does not receive a separate allowance from Max history tokens, and a native WI budget can exclude the profile. Semantic WI candidates are prepared before hints are appended.

Hints refer to their cited historical message positions. Later original chat can establish learning or supersede an old state; a hint must not create permanent ignorance. Source edits, missing sources, manual hiding, changed L0 or changed character identity can withhold a derived hint. The narrator retains the original secret in history; the hint controls attribution of knowledge to the named NPC, rather than removing the fact from the narrator's context.

Existing packets require an explicit **Rebuild search notes / WI** or **Prepare missing search notes / WI** operation. Preparation can make one existing stage2 request per eligible packet. Only already managed character identities are available to that request; characters first created by its WI output may require later preparation. With no supported knowledge changes, no knowledge paragraph is appended. Malformed optional output keeps the saved L0 and ordinary metadata.

The feature adds no generation request per RP turn and does not change history embedding search or implement vector subtraction. A single narrator receiving the whole context can still misuse a hint or expose a secret; this is source-linked assistance, not a security boundary. Inspect it with `WorldMemory.inspectKnowledge()` in the browser console when diagnosing a chat.
