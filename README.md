# World Memory

[Русская инструкция](README_RU.md)

**0.1.0 · alpha.** Character profiles and reusable World Info from the story saved by Summaryception. Summaries keep the chronology; World Memory keeps references about people, places, objects and groups.

It makes **separate model requests through Summaryception's configured connection**, which can incur additional provider costs. It does not rewrite Summaryception's narrative summaries.

## Quick start

1. Install or update [Summaryception to 5.5.4-local.19 or later](https://github.com/Ilya626/Extension-Summaryception). Other forks may not provide the required companion API.
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

5. Save an L0 summary in Summaryception, or click **Update WI now** to process existing packets. Review **Characters**, **Other records and sources**, or **Open lorebook**.

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

## Updating and keeping control

- **Automatic updates** follow saved memory changes and process new or revised L0 packets. Original L0 evidence remains available after promotion to higher Summaryception layers.
- **Update WI now** reprocesses available, non-stale saved packets, including previously processed ones. A run can make several requests; rebuilding affected records can require more.
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

Review important results in **Open lorebook**. Extraction, identity matching and completeness depend on the model; character profiles are requested, but omissions remain possible. Shared names and broad keys can activate the wrong native record. Large histories can require many paid requests. Legacy summaries may lack original-message links. Vector retrieval and custom matchers bypassing native WI are outside this integration. Compatibility with every ST version, provider or addon is not promised.

Code license: [MIT](LICENSE).
