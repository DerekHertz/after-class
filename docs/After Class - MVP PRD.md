---
created: 2026-11-03
status: draft-for-user-review
priority: starred-contender
---
# After Class: MVP product requirements

After Class turns watched educational material into a source-grounded conversation that reveals what the learner can explain, what required help, and what remains uncertain. The first live integration is YouTube in desktop Chrome on Windows. The name and product direction allow other learning sources later.

This is the consolidated review draft from the grilling session. It replaces conflicting product proposals in [the original Lecture Companion draft](../Lecture%20Companion%20-%20YouTube%20Socratic%20Learning%20PRD.md). [The grilling state](After%20Class%20-%20Grilling%20State.md) preserves the decisions and [the implementation-spec draft](After%20Class%20-%20MVP%20Implementation%20Spec.md) proposes their technical realization. Neither document establishes that capture, Jev accuracy, or model integration has been tested. Implementation is explicitly reserved for a separate session.

## Purpose and first user

Derek is the first MVP user, motivated by short educational videos and OMSCS lecture sequences. The intended broader audience is people learning from educational YouTube videos. The core promise is to help the learner explain and apply ideas and identify specific gaps worth revisiting. A useful session may end with unresolved questions.

The showcase should demonstrate a complete usable path and defensible engineering choices. A nominal one-day build ambition does not override the requirements below. No claim of improved grades, delayed retention, or educational efficacy is established by a pleasant conversation or a successful software demo.

## Accepted MVP scope

| Feature | User-visible outcome |
| --- | --- |
| Explicit session capture | Start capture for a YouTube tab, see recording health, and pause or stop it. Continue across subsequent videos in that session tab. |
| Timestamped visual and transcript evidence | Inspect captured passages and frames aligned to watched media intervals, including gaps and transcript provenance. |
| Jev semantic preprocessing | Propose meaningful teaching boundaries using separate concept-change and stopping-point judgments. Preserve uncertain teaching frames. |
| Background preparation | Interpret completed chunks while viewing continues, including when the learner defers discussion. |
| Invited review | Choose Review now or Later. Review now remains available independently of invitations. |
| Socratic discussion | Speak or type, reconstruct an idea, discuss applications, receive targeted follow-ups, and inspect relevant source evidence. |
| Diagnosing assumptions | Explore the reasoning behind a mismatch before receiving a correction; choose whether to take a prerequisite detour. |
| Connected resources | Make user-provided and web-discovered resources available with explicit links to lecture concepts. |
| Local learning record | Save notes, learner explanations, assistance, disputes, corrections, unresolved concepts, and source references. |
| Embedded concept graph | Explore subject relationships with personal learning observations layered separately; inspect and correct suggested links. |
| Repeat-viewing reuse | Reuse cached preparation and prior discussion without equating replay with lost progress or mastery. |
| Usage visibility | See recorded usage and cost, including unknown values and partial reporting. Personal MVP usage is uncapped. |

Canvas, universal video/player support, full-course indexing, shared learning from other users' confusion, cross-device sync, and automatic cloud backup are outside the MVP. JEPA is excluded from the selected preprocessing path. Cross-user source-cache sharing is not required. Obsidian integration or export is optional future scope, with no selected delivery commitment; local saving is the required first path.

## Main journey

1. Open a supported YouTube video and explicitly start a capture session. See source identity, recording state, caption/transcript availability, and visual-capture health.
2. Watch normally, potentially through several short videos. Code records watched intervals and aligns transcript passages and frames to media time. Pauses, seeks, replay, and speed changes must not corrupt those references.
3. Jev makes narrow boundary judgments during viewing. Code combines them with timing rules. A slide change or video end alone does not prove a useful teaching boundary.
4. When a chunk closes, background interpretation begins. The app can offer a review at a meaningful topic boundary, using accumulated time as a fallback. Selecting Later carries the material forward and does not prevent preparation.
5. Start a review with an explicit scope. If processing is incomplete, see Processing and an estimate only when reliable. Stop early reviews only the prepared portion and labels it partial. Capture gaps likewise produce visible partial coverage.
6. Answer an open recall question. The tutor can ask up to three main questions, with follow-ups when needed, while keeping frames and transcript available beside the conversation.
7. When an answer conflicts with the source, discuss the likely assumption or misinterpretation. A suggested diagnosis remains tentative until the learner's answer supports it. Ask before exploring prerequisite material.
8. At a natural pause after the planned discussion time, choose whether to continue or wrap up. Time is a soft target, not a forced cutoff. The original ten-to-fifteen-minute discussion is a starting proposal, not a newly approved fixed default.
9. Save a concise local record and inspect or correct it. Return later to unresolved concepts or rewatch the source using cached preparation.

Newly watched material queues for a later review unless the learner explicitly adds it. Corrections to the sources or interpretation can affect the current review, but must be explained and must not silently enlarge its assessment scope.

## Capture and evidence requirements

Capture is performed through code, with user activation and visible controls. The tutor does not continuously observe the user's desktop. Test the actual extension-to-app path on Windows Chrome before claiming supported capture.

Each evidence item preserves source identity, a media timestamp or interval, provenance, capture status, and references to the underlying passage or readable frame. A wall-clock timestamp is not a substitute for media time. Exposure records are separate from learning observations.

Prefer available captions. If captions are missing or unusable, offer opt-in audio transcription with machine-generated provenance and timestamps. Audio access remains a feasibility question. Missing transcripts, failed capture, unreadable frames, and unaligned passages are explicit gaps, not invented content.

Visual selection must account for incremental handwriting, equations, diagrams, animations, and code edits. Periodic capture plus inexpensive visual-change detection is a proposed implementation. Jev can help classify candidate changes; its accuracy on this material is not yet established. Keep uncertain frames by default and measure important steps lost by selection.

## Preprocessing and interpretation

Jev is selected for narrow semantic judgments. Give it a rolling transcript window and preceding context, with relevant frames when meaning depends on visuals or text alone is ambiguous. Ask separately whether a new concept began and whether the prior explanation reached a stopping point. Code owns routing and timing. Uncertain boundary judgments continue collection and use the time fallback.

During viewing, code gathers and organizes evidence and loads user-provided sources. Deep concept interpretation and connected web search wait until a meaningful chunk closes. Limited semantic boundary checks are interpretation; preprocessing is not described as entirely nonsemantic.

The reasoning model creates evidence-linked concept descriptions, assumptions, potential confusions, and supplemental connections. Jev checks whether supplied evidence supports concept descriptions before the tutor uses them. Visually dependent claims require frame evidence. Allow one revision attempt after a failed or uncertain check; if still unsupported, preserve the claim as unverified and exclude it from learner assessment. Passing a model check is not proof of truth.

Boundaries remain adjustable. If later material reveals that an explanation was continuing, revise the affected chunk and its interpretation while preserving the evidence. During review, disclose the correction, show the relevant evidence, and update only affected explanations and learning records.

## Supplemental resources

User-provided and lecturer-linked sources are supported, and broader web search is allowed after chunk closure. Every supplemental source needs a citation and a short, inspectable connection to a core lecture concept. Keep source statements, model interpretations, assumptions, and supplemental explanations distinguishable.

Resource search is independent of core review readiness. Start a ready lecture-based review while searches continue. If a proposed prerequisite detour requires a pending source, offer to wait or continue with lecture evidence. Supplemental resources do not silently expand what the learner is expected to know.

## Tutor and learning record

Lead with an attempt to reconstruct the material rather than giving away the answer through a recap. Allow skip, I don't know, hints, a direct explanation, pause, and early ending. Distinguish independent explanation, partial explanation, explanation after help, unresolved, and not assessed. A supplied answer, unanswered question, or skipped question cannot count as demonstrated understanding.

If the learner disputes an interpretation, mark the assessment disputed, inspect the source, and let the learner explain the disagreement. Leave it unresolved when the evidence does not settle it. Neither the model nor the lecture is treated as infallible.

Save covered videos and intervals, concise concepts, the learner's own explanations, meaningful assistance and corrections, unresolved questions, and evidence links. Learner and tutor contributions remain distinguishable. Preserve user edits and avoid duplicate records on retries. Exact note editing and save-recovery behavior are implementation proposals to review.

## Concept graph and rewatching

Concepts, relationships, evidence, and learning observations are stored independently of the visualization library. Subject relationships do not change merely because the learner's progress changes. Inferred links are suggestions with supporting evidence, which the learner can accept or correct. Relationship types, graph interactions, and the rendering library remain design choices.

Cached source preparation is reused when its source and processing versions match. Rewatch reviews can use previous discussions to revisit unresolved gaps and ask fresh questions, with a fresh-review option. Seeking or replaying does not automatically reset progress or prove confusion. The precise cache keys and invalidation rules need engineering validation.

## Local data, keys, and cost

Store captures and learning history locally. Send selected evidence to model providers as necessary; local storage does not mean all inference happens locally. User-supplied API keys belong in the local backend, not in the YouTube page. Select secure key storage during implementation.

Uncited raw captures expire after a configurable thirty-day default. Notes, learning history, and supporting evidence cited by saved notes remain until user deletion. Capture already used in saved evidence must not disappear silently through cache eviction.

Personal MVP use is uncapped, superseding the earlier spending-limit proposal. Track provider usage and total cost across the pipeline; distinguish measured usage, estimated cost, incomplete reporting, and unknown values. Uncapped use is not authorization to run paid calls in this planning session. No provider credits are assumed to cover application inference.

## UX direction

Use an extension for capture controls and invitations, and a dedicated After Class review view with conversation beside relevant frames or transcript. Support speaking and typing. Detailed layout, navigation, graph design, visual style, and accessible interactions remain for UX and product design. This document does not imply a visual design sign-off.

## Agreed end-to-end acceptance demonstration

Use a real supported YouTube lecture, including at least one case where a diagram or equation is necessary to understand the material. Demonstrate:

1. Code-driven capture of timestamped transcript and meaningful visual steps on the target browser path.
2. Inspectable Jev preprocessing inputs, judgments, routing, and uncertain outcomes.
3. Source comparison of prepared concepts and explanations, recording inaccuracies rather than assuming model-check success establishes accuracy.
4. A short source-grounded review and a saved local learning record that attributes learner and tutor contributions correctly.
5. Reported capture/coverage gaps, model errors, processing delays, usage, and cost.

This establishes a minimum real-path demonstration, not broad educational efficacy or universal reliability. Also evaluate cases not used to tune the pipeline: an unchanged-slide topic change, a slide change within one concept, incremental visual steps, replay/seeking, missing captions, partial capture, a disputed answer, and repeat-viewing cache reuse. Numerical accuracy and latency targets, acceptable error rates, and the evaluation corpus remain proposed engineering acceptance work to set before final evaluation.

A replayable public sample can demonstrate the experience without live keys. Label replayed data and distinguish that demonstration from live capture. Use material suitable for redistribution or a purpose-made sample.

## Delivery and review boundary

The requested deliverable is this draft and its accompanying spec. No application code, installation, paid probe, deployment, or publication was requested here. Tutor/voice models, application stack, numerical thresholds, latency targets, supported capture methods, and detailed UX are not silently selected by this draft.

The flow skill's consolidated flow is provided as a proposal in the spec. The user has not yet reviewed that complete flow, supplied their rules in their own sentences, or completed the formal lifecycle check. Those stages remain explicit review work, not completed verification. Implementation belongs in the user's separate session after reviewing these drafts.
