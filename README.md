# World Memory

[Русская инструкция](README_RU.md)

**0.2.0 · alpha.** Character profiles and reusable World Info from Summaryception, with optional addressable history: a compact timeline that opens relevant original exchanges at their chronological positions.

It makes **separate model requests through Summaryception's configured connection**, which can incur additional provider costs. It does not rewrite Summaryception's narrative summaries.

## Quick start

1. Install or update [Summaryception to 5.5.4-local.21 or later](https://github.com/Ilya626/Extension-Summaryception). Other forks may not provide the required companion API.
2. For Russian chats, also install [Russian WI Forms](https://github.com/Ilya626/Extension-RussianWI). It is optional: ordinary keys such as `меч` can then match dictionary forms such as `мечом`.
3. In ST's **Extensions → Install extension**, paste:

   ```text
   https://github.com/Ilya626/Extension-WorldMemory
   ```

4. Reload ST, open a character chat and expand **World Memory**. In **Main characters to always track**, enter your cast, one name per line:

   ```text
   Mira
   Anton
   ```

5. Save an L0 summary in Summaryception, or click **Update memory now** to process existing packets. Review **Characters**, **Other records and sources**, or **Open lorebook**.

Automatic updating and **Always include main character profiles** are enabled by default. Update through ST's extension manager, then reload the page. The manifest also enables native automatic updates where ST permits them.

## A small example

Fictional played scene: *Anton, the workshop keeper, lends Mira a brass key until morning. Mira tries the cabinet lock, but it does not open.* Suitable profiles would be:

| Record | Example reference |
| --- | --- |
| Mira — character | Borrowed Anton's brass key until morning. Tried the cabinet lock without opening it. |
| Anton — character | Workshop keeper. Lent Mira the brass key until morning. |
| Brass key — object | Currently borrowed by Mira from Anton. The recorded attempt did not open the cabinet; the reason is unknown. |

This illustrates the intended output, not a guaranteed model response. Attempts must not become successes. Unplayed events and character-card secrets are not evidence. A named character without supported facts may remain an empty profile; a name alone does not supply a biography.

## Native World Info

The addon creates a **separate native book for the current chat**. Your existing chat-book assignment and original lorebooks stay in place. Entries join native scanning through `WORLDINFO_ENTRIES_LOADED`; you do not need to change the existing binding or manually attach the generated book.

Main profiles use ST's **Constant** strategy by default. Other records use ordinary keyword activation. Russian WI Forms handles inflections during scanning without writing generated regexes into the book. Records still follow the native WI budget, disabled flags and insertion rules; Constant does not bypass the budget.

The default position is **In-chat @ Depth**, depth **2**. Before/After Main Prompt and Before/After Author's Note are also available. Your ST prompt configuration determines the final order.

## Optional history with selective detail

Open **History with selective detail** and enable **Build and use addressable L0 / L0′ history**, then click **Update memory now**. It is off by default. Existing summaries and custom prompts are preserved.

The same request that extracts WI also receives the packet's **complete original sources**, grouped into whole exchanges. It returns a detailed episode (**L0 detail**), a short causal anchor (**L0′**), and search keys for each addressed group. The 4,000-token optional-detail setting applies to WI-only mode; history mode needs the complete source packet. This increases input/output tokens. For large packets, consider an 8,192-token response limit and check the result status.

Before a normal RP reply, the current post and previous assistant reply search detailed episodes **and original exchanges**. Results choose which parts to open. They are assembled in source order, never appended as a relevance-sorted pile:

```text
short scene 1 → original exchange from scene 2 → short scene 3 → live chat
```

A partial excerpt keeps a short scene frame. If originals cover the entire episode, they replace its summary. The history uses Summaryception's selected insertion position. It does not unhide chat messages or alter the live tail/Blind Zone. WI continues through native ST scanning and its own insertion settings.

Defaults: **4,000 tokens** for the compact timeline and **4,000 additional tokens** for selected detail. Whole exchanges are kept; an oversized candidate is skipped, allowing smaller candidates to fit. If the compact timeline itself cannot fit, source links are stale/overlapping, or preparation fails, the ordinary Summaryception layers remain active. This first implementation does not recursively shrink an indefinitely growing L0′ timeline.

### A simple post-response structure

With **Ask the RP model for a hidden scene / keys / carry block** enabled, the model is instructed to append:

```text
Anton hands Mira the key. “Bring it back before morning.”
<memory_hint>
anchor: Anton lends Mira the key
keys: Anton; Mira; brass key; borrowed key
carry: return the key before morning
</memory_hint>
```

The post is visible; the service block is hidden during streaming and detached into that message's selected-swipe metadata after completion. There are exactly three short fields; `-` means empty. No tool calling is required. Hints are search suggestions, not established world facts. Missing or malformed markup never rejects the RP reply. Editing its text invalidates the old hint; another swipe keeps its own hint.

### Keyword search and optional embeddings

Local keyword search is the default. Russian WI Forms **0.1.2+** supplies dictionary lemmas for history search as well as its existing native WI inflections. No extra generative call is made before each RP reply.

For optional semantic history search, first configure a hosted embedding provider/model and its key in **ST Vector Storage**, then enable **Also search using ST's configured hosted embeddings** here. Supported sources: OpenAI, OpenRouter, Cohere, Together AI, Electron Hub, Chutes and NanoGPT. Only this explicit switch allows embedding requests; provider charges may apply. The addon uses native ST vector routes, caches by text, deletes obsolete vectors and fuses semantic/keyword candidate ranks. An unavailable service falls back to keywords. It downloads no model and runs no reranker on the phone. This switch does **not** force semantic activation of native WI entries.

### Storage and maintenance

The original chat and Summaryception archive remain authoritative. Message metadata holds the selected reply's hint and text fingerprint. `chatMetadata.worldMemory.history` holds packet revisions and source-linked detailed/compact episodes. Addresses are assigned by code from the exact saved source IDs, not guessed by the model. There is no separate database for the text memory.

Edits, swipes, deletion and summary regeneration invalidate prepared context. Deleted packets are pruned on the next memory update; changed packets are rebuilt from their current sources. A failed optional annotation keeps the valid original L0 and any valid same-revision episodes; it does not repeatedly retry old packets automatically. **Update memory now** can retry explicitly. Stop keeps completed saves.

World Memory backup includes these episodes. Also export the ST chat to retain original messages and per-swipe hints; a lorebook alone cannot restore the history. Importing another chat's World Memory backup keeps its references as manual records and clears old history/source links. Disable selective history to return to ordinary Summaryception injection.

## Updating and keeping control

- **Automatic updates** follow saved memory changes and process new or revised L0 packets. Original L0 evidence remains available after promotion to higher Summaryception layers.
- **Update memory now** reprocesses available, non-stale saved packets, including previously processed ones. A run can make several requests; rebuilding affected records can require more.
- **Stop** cancels current work. Already saved packets remain; completed work is not rolled back.
- Contributions track packet IDs and source-message IDs. Removing a Summaryception packet removes its automatic contributions on the next update. Affected automatic records are rebuilt from remaining contributions or deleted when none remain. Manual records are preserved.
- Edited, deleted or swiped source messages make affected linked packets stale. Regenerate those summaries in Summaryception before updating WI.
- Use **Keep manual** before maintaining a record yourself. Changes to generated titles, primary keys, content, Constant and disabled status are also detected. Protected records are skipped; **Allow automatic updates** opts them back in. Manually added native entries are outside automatic ownership.

## Request defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| Maximum response tokens | **4096** | Per response; **0** inherits Summaryception's response setting. |
| Original-message detail tokens per packet | **4000** | Optional whole messages, selected newest first. The complete saved L0 summary is always supplied. |
| Prior entry-fact tokens per request | **6000** | Retained facts supplied during extraction, considering main profiles first. Not a limit on the entire prompt or every rebuild. |
| Target tokens per entry | **160** | Writing guidance, not a strict size cap. |

Language can follow the source or be set to English/Russian. Model context limits still apply: the complete summary and entry index also take space; a large rebuild can exceed the extraction fact budget.

## Chat copies and backups

A branch or renamed/copied chat detected under a different chat ID gets its own book when updated. Owned records are copied rather than written through to the source chat's book. Review source links after trimming messages.

**Export backup** saves the book, cast names and packet links. **Import backup replaces this chat's World Memory book contents**; export the current version first if needed. A backup from another chat becomes protected manual records with its old contribution links cleared. It does not transfer that chat's Summaryception packets. Native lorebook JSON can also be imported through ST's World Info editor, but connecting a book there alone does not establish automatic ownership or chat linkage.

## Alpha limits

Review important results in **Open lorebook**. Extraction, identity matching and completeness depend on the model; omissions remain possible. History groups follow exchange/token boundaries, not guaranteed semantic scene boundaries. Shared names and broad keys can activate the wrong native record. Large histories can require many paid requests. Legacy summaries may lack original-message links. Hosted semantic history search is optional; semantic WI activation and local rerankers are not implemented. Compatibility with every ST version, provider or addon is not promised.

Code license: [MIT](LICENSE).
