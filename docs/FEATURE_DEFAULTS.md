# Recommended feature defaults · Выбор функций

2026-10-31. These are starting settings for new installations and the explicit recommendation button. Updating preserves saved choices. Budget controls remain separate and editable.

| Setting | Default / recommendation | Basis |
| --- | --- | --- |
| Semantic history | On, API `gemini-embedding-2-preview`, 768 dimensions | More fully supported retrieved needs in the existing two-game comparison. |
| Hidden search hints | On | Engineering choice: a short navigation cue in the same reply; no extra generation request. No on/off quality gain has been measured. |
| Outline reranking | Off | Small retrieval gains and losses; one concrete natural-post gain in a directed Flash pilot, without a consistent overall RP gain. |
| Semantic WI | Off | Functional native activation has been demonstrated; comparative gameplay improvement across both games has not. Native keys, Constant and optional Russian WI Forms remain primary. |
| NPC information events | Off, experimental | Local improvements and errors; no consistent general improvement in the controlled replies. |
| Related evidence / local graph | Off, experimental | Mixed replies; no established general gain. The local graph itself adds no model calls. |

The embedding comparison used **240 assemblies / 120 pairs**, keeping the same complete outline and source chronology. For the **30 natural posts**, fully supported needs rose from **23 to 28 of 48 at nominal 24k**, and **33 to 37 at nominal 32k**. At 32k the paired support changes were **4 gains, 0 losses**; at 24k, **7 gains, 1 loss**. Weighting the three pools equally or weighting the two games equally favors preview. Question triples also had individual losses and remain a separate diagnostic cohort.

These are evidence-delivery results, not reply accuracy or universal improvement. All measured assemblies exceeded their soft envelope by a final whole passage. They do not establish a hard 24k/32k fit or a jointly optimal combination of features. The NPC/graph comparisons used single stochastic replies and overlapping prefix checkpoints; no combined win score is assigned.

Hints can add instruction/output tokens and an embedding input when their saved cue is indexed. Reranking may require vectors for new outlines. Semantic WI may require vectors for WI entries and historical source queries; an identical current-post query can share the history query vector. Information events use the existing second background request when enabled; older-archive preparation can require explicit additional requests. There is no new mandatory per-turn LLM verifier or third preparation call.

`gemini-embedding-001 / 768` remains available by manual selection. The two models have separate profiles/caches and different task protocols. Changing models can require new document vectors; it does not replace saved history, source links or WI. The exact tested model is **2-preview**.

## По-русски

По умолчанию включены смысловой поиск истории через **2-preview / 768** и скрытые hints. Hints — инженерный выбор без доказанного on/off-выигрыша; они не требуют отдельной генерации, но могут добавлять токены и векторизацию. Rerank, semantic WI, события осведомлённости и граф остаются выключенными: их полезность в отдельных случаях не стала устойчивым общим результатом двух игр.

Обновление не заменяет сохранённые настройки. Рекомендации применяются явно кнопкой. `001 / 768` остаётся ручной альтернативой; профили и векторы моделей не смешиваются. Полный доступный L″ сохраняется. Эти настройки не являются гарантией качества каждого ответа или размещения всего запроса в жёстком лимите.
