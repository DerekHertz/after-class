---
updated: 2026-11-03
status: draft-delivered-awaiting-user-review
priority: starred-contender
---
# After Class: saved grilling state

The user paused for JEPA research, chose Jev, resumed grilling, then requested consolidated drafts for review. Grilling is now parked at the draft-review handoff. Implementation is reserved for a separate session. If grilling resumes, continue one question at a time using `grill-the-flow` at `/home/dhertzell/.claude/skills/grill-the-flow/SKILL.md`; do not restart settled questions.

This file records decision provenance. The consolidated [MVP PRD](After%20Class%20-%20MVP%20PRD.md) is the current product review draft; the [implementation spec](After%20Class%20-%20MVP%20Implementation%20Spec.md) contains proposed contracts, actor-tagged flow, lifecycle sketch and verification plan. Both supersede conflicting proposals in [the historical Lecture Companion PRD](../Lecture%20Companion%20-%20YouTube%20Socratic%20Learning%20PRD.md). Earlier spoken statements that the PRD had already been updated were inaccurate; the local files now contain the saved decisions and reconciled drafts.

## Product decisions accepted

- The chosen product name is **After Class**. Keep the product identity broader than lectures alone; YouTube remains the first integration and Canvas remains later.
- The core promise is to surface what the learner can explain and apply, expose gaps, and preserve a faithful learning record. A session can be useful even if some gaps remain unresolved.
- Invite the user to review rather than launching directly into questioning. Offer Review now and Later; Review now remains available independently of an invitation.
- Prefer a meaningful topic boundary as the review trigger, with accumulated viewing time as a fallback. A topic may span several short videos. Five videos is an example, not a fixed trigger.
- Choosing Later carries the material forward and defers another invitation until a later topic boundary. Exact fallback timing and repeat-prompt rules remain unspecified.
- Begin with an open recall question. Allow up to three main discussion questions, with follow-ups when needed. This is discussion rather than a conventional quiz.
- Time is a soft target. At a natural pause after going over the planned time, ask whether to continue or wrap up; do not forcibly end.
- Support both speaking and typing, with relevant transcript passages and frames visible, including equations and code.
- Reviews open in a dedicated After Class view, with conversation beside relevant frames or transcript passages. The Chrome extension handles capture controls and review invitations. The user explicitly wants room for later UX and product design; detailed layout, navigation, and visual design are not settled by this structural choice.

## Diagnosis and learning evidence

- Compare the learner's explanation with the watched source material, including visuals.
- First diagnose the reasoning behind a mismatch. Use a specific, tentative question grounded in the source rather than assuming why the learner misunderstood.
- Example: ask whether an assumption stated in one example was carried into a later case where it no longer applied.
- If the answer reveals a prerequisite gap, offer a short detour and get the user's go-ahead before taking it.
- Preserve the original distinctions between independent explanation, partial explanation, explanation after help, unresolved, and unassessed. Tutor explanations do not establish learner understanding.
- If the user disputes a tutor interpretation, mark the assessment disputed and recheck the source before treating the answer as a learning gap. Show relevant evidence, let the user explain the disagreement, and leave it unresolved if the source does not settle it.

## Storage and embedded concept graph

- Prefer a small database for each user's information. The physical deployment and isolation design are not selected; do not equate this with a requirement for a separate database server per person.
- MVP captures and learning history are stored locally on the user's computer. Send selected evidence to model providers as needed. Cross-device sync and automatic cloud backup are outside the MVP; the exact local database and retention policy remain open.
- Live sessions use user-supplied provider API keys, held by the local backend and not exposed to the YouTube page. A replayable sample can demonstrate the experience without live keys. Secure key storage details remain to be selected.
- Updated personal-MVP decision on November 3: usage is uncapped for now so the user can observe actual expense. Track usage and cost across preprocessing, interpretation, transcription/voice, tutoring, and external services. Mark unavailable usage/cost unknown rather than zero. This supersedes the earlier required per-session spending cap; configurable caps can be reconsidered later.
- Raw captures expire after a configurable 30-day default unless cited by saved notes. Notes, learning history, and their cited supporting evidence remain until user deletion. Exact cleanup, cache eviction, and deletion controls remain to be designed.
- The conversation moved toward keeping notes and learning records inside After Class. Whether Obsidian remains an optional integration or export is still open; the user did not explicitly accept a complete Obsidian replacement or a specific export roadmap.
- Use embeddable graph components rather than making a separate knowledge-management app the product's primary UI.
- Keep concepts, relationships, source evidence, and user learning observations independent of the graph-rendering library. React Flow and Cytoscape.js were discussed; neither was selected.
- Map subject relationships separately from the learner's changing progress. Subject links are claims about the material, not automatically established truths.
- Inferred concept connections appear as suggested links with supporting lecture evidence, which the user can inspect, accept, or correct.

## Capture, preparation, and interpretation

- Ground discussion in portions actually watched. Watching is exposure, not evidence of mastery. The policy for retrieving nearby unwatched context remains open.
- During viewing, collect and organize timestamped transcript passages, relevant video frames, and user-provided resources. Store material for future model calls; do not describe this as continuously uploading into an always-running reasoning model.
- The user revised an earlier preference for immediate deep interpretation: deeper lecture interpretation and related web search should wait until a meaningful chunk is complete.
- Narrow semantic boundary checks during viewing are accepted. They are a limited form of interpretation; preprocessing cannot honestly be described as entirely nonsemantic.
- Jev is selected for focused preprocessing judgments. Give it a rolling transcript window with preceding context, adding relevant frames when meaning depends on visuals or the transcript alone is ambiguous. Exact window sizes and visual accuracy remain to be tested.
- Jev separately judges whether a new concept began and whether the prior explanation reached a stopping point. Code combines both judgments with elapsed-time rules before suggesting review. This is an accepted design, not a validated lecture capability.
- A detected boundary starts background interpretation of the completed chunk even when the user chooses Later for discussion. Preparation proceeds while viewing continues so it can be ready when review is requested.
- Boundaries remain adjustable when later context reveals an explanation was continuing. Preserve captured evidence, revise the affected chunk, and update its interpretation.
- If revision affects an active review, correct the affected explanation openly, show supporting evidence, and update only the affected learning record; preserve unrelated discussion.
- Each interpreted concept links to exact supporting transcript passages and frames. Label assumptions and supplemental connections separately.
- Jev performs a semantic evidence check on whether the supplied passages support the reasoning model's concept descriptions before those descriptions are used by the tutor. Unsupported or uncertain claims cannot become the basis for judging learner answers. Allow one revision attempt; if the claim still cannot be verified, mark it unverified, expose the coverage gap, and continue with verified material. Offer to revisit the source rather than assess that concept. This check's lecture-specific reliability remains untested.
- When a concept depends on a diagram or equation, its semantic evidence check includes relevant frames as well as transcript passages. Uncertain visual checks remain unverified; visual accuracy needs validation.
- First capture target: desktop Chrome on Windows, using an extension connected to the After Class app. Test transcript access, timestamp alignment, frame capture, and opt-in audio transcription on that path before claiming feasibility.
- Capture starts explicitly, then continues across subsequent YouTube videos in the session tab until paused or ended. Keep a persistent capture indicator and accessible pause/stop controls.
- If a boundary check is uncertain, continue collecting material and use the time fallback.
- For visuals, combine periodic capture and visual-change detection as a proposed approach. The user specifically proposed Jev to help identify meaningful slide/visual changes. Its visual accuracy needs testing.
- Keep uncertain frames by default. Exact sampling, deduplication, retention, and selection policies are still open. Do not turn the assistant's proposed strategy into a benchmarked design.
- Use captions where supported. When captions are missing or unusable, offer opt-in speech-to-text transcription, keep timestamps, and label machine-generated provenance. Browser audio capture feasibility is unverified.
- If review is requested while preparation is incomplete, show Processing. Show a remaining-time estimate only when reliable. The user accepted Stop early to stop background processing and review the prepared portion, explicitly marked partial. Cancellation, checkpointing, and later resumption details remain open.
- If capture misses part of a session, allow a clearly labeled partial review and display the missing intervals. The no-usable-evidence outcome remains to be specified; do not manufacture review content for uncaptured material.

## Supplemental resources

- Prepare the review around the watched lecture rather than automatically expanding the learner's expected knowledge to supplemental material.
- User-provided sources may load during viewing. Reading/interpretation of them must respect the revised separation between collection and deeper interpretation; the precise boundary remains to be specified.
- Broader web search is allowed for connected resources once the chunk is complete. It need not wait for user-provided and lecturer-linked materials to be exhausted.
- Keep supplemental resources separately indexed and cached where possible, available for diagnosis when needed.
- Every external source should have an inspectable connection to a core lecture concept, a citation, and a short relevance explanation. An evidence trail is required; hidden model reasoning is not a product output.
- Keep supplemental explanations distinct from what the lecture taught. Ask before taking a prerequisite detour.
- Supplemental searches run independently and do not block a ready lecture-based review. If a prerequisite detour needs an unfinished search, explain that and offer to wait or continue with lecture evidence.
- Each review has an explicit scope defined by watched material included when it starts. Newly watched material queues for a later review unless the user adds it. Source corrections can still update the active review; they do not silently expand assessed viewing scope.

## Reuse and replay

- Cache preprocessing for repeated viewing in the MVP. Reuse matching source preparation rather than recomputing it every time.
- Cache keys, source revision checks, processing-version invalidation, and handling partially watched content still need design.
- Use the learner's previous discussions on rewatch to revisit unresolved gaps and ask fresh questions. Offer a fresh-review option.
- Seeking backward or replaying does not automatically erase demonstrated progress or prove confusion. Preserve progress and clarify the reason when useful, without making every seek an interruption.
- Learning from aggregated confusion across users is outside the MVP. Cross-user source-cache sharing was discussed but not separately finalized; do not silently include it in the first release.

## Original input/output example and later agreement

The original derivatives example preceded later accepted decisions on rolling Jev inputs, separate boundary judgments, evidence-linked claims, visual support checks, and one revision. Those behaviors are now accepted in substance. The exact data schema remains an engineering proposal in the implementation spec:

1. Code captures watched transcript passages and frames with timestamps and stable evidence IDs.
2. Code sends adjacent transcript windows and corresponding frames to Jev for bounded judgments about topic change and stopping points.
3. Code assembles a completed watched chunk for the interpreting model: source identity, watched intervals, aligned transcript/frames, explicit capture gaps, provisional Jev annotations, and retrievable original evidence. Supplemental resources occupy a separate section.
4. The model produces structured concepts, evidence IDs, assumptions, possible confusions, and supplemental prerequisite connections.
5. The tutor retrieves this record and original evidence to ask questions and diagnose actual learner answers. A possible confusion remains a hypothesis until the dialogue supports it.

The user asked for examples and more structured answers. Code can validate required fields, timestamp bounds, and whether cited evidence IDs exist. Those checks alone cannot establish that a claim is supported by the cited evidence; semantic correctness needs evaluation.

The final accepted retention policy is thirty-day configurable expiry of uncited raw capture, with saved notes, learning history, and their supporting cited evidence retained until user deletion. This does not require unlimited retention of every frame.

## Research requested at the pause

User request: "look into jepa, give me the details and if it fits in for preprocessing at all, finding a subject change may require semantic interpretation".

Research deliverable: [JEPA preprocessing assessment](research_notes/After%20Class/JEPA%20preprocessing%20assessment.md). Research findings are recommendations and do not adopt JEPA into the design.

Research completed by source review, without a live probe. Latest official V-JEPA release found: V-JEPA 2.1. It offers visual features, not an out-of-the-box lecture topic detector. VL-JEPA's streaming semantic embeddings are closer to the desired semantic monitoring, but usable official trained weights were not verified. Recommendation: transcript-led semantic boundary checks with supporting visual evidence for the MVP; treat JEPA as an optional measured comparison. Preserve the already accepted distinction between narrow boundary interpretation during viewing and deeper interpretation after a chunk closes.

Subsequent user decision: "let's stick with jev". Continue with Jev for the planned narrow preprocessing judgments rather than adding JEPA. Lecture-specific reliability, exact questions, input windows, thresholds, and visual support remain untested. The follow-up question is whether Jev can provide semantic interpretation: its documented passage relevance/evidence/contradiction judgments support semantic classification; open-ended explanations and concept writing remain the reasoning model's job. The live TypeSafe passage-classification cookbook was successfully read for this clarification; earlier attempts to access other documentation pages had failed.

## Accepted end-to-end proof and review handoff

On November 3 the user accepted a concrete MVP demonstration: code-driven capture of a real supported YouTube lecture's timestamped transcript and meaningful visual steps; inspectable Jev preprocessing decisions; source checking of generated explanations; a short review; a saved local learning record; and reported errors, gaps and cost. Include at least one lecture where a diagram or equation is necessary to understand it. No such demonstration has been executed yet.

The user asked to finish lightly and requested the PRD/spec draft for review, with implementation in a separate session. Do not continue unsolicited grilling or start application implementation here. Detailed UX/product design remains open.

The current review deliverables are:

- [After Class - MVP PRD](After%20Class%20-%20MVP%20PRD.md): reconciled product behavior, scope, learning record, data/cost policy and accepted proof.
- [After Class - MVP Implementation Spec](After%20Class%20-%20MVP%20Implementation%20Spec.md): proposed technical responsibilities, records, Jev questions, actor-tagged flow, illustrative lifecycle, delivery sequence and verification matrix.

Still open for review/engineering: tutor and voice providers, application stack and local database, secure key storage, actual capture/audio methods, numerical accuracy/latency criteria, window sizes and thresholds, bounded concurrency/search, source/cache invalidation, cancellation and stale callbacks, graph relationship types, detailed note editing and UX. These are explicitly proposals or unresolved choices, not hidden approvals. The uncapped cost decision supersedes earlier spending-cap defaults.

The consolidated flow is written but has not been approved as a whole. The user has not supplied invariant sentences in their own words. No statechart/TLA+/TLC verification has run. The Mermaid in the spec is only an illustrative preparation lifecycle, not a checked model. On review, follow the flow skill for flow agreement, user-written rules and formal checks; do not manufacture the user's rules from prior yes/no answers.

## Delivery status

Consolidated drafts and research only. No application implementation, installations, paid model calls, runtime capture tests, formal checks, deployment, or cross-project context-store writes were performed. Usage/cost and model accuracy for the proposed application remain unknown. The user will review the drafts before taking implementation into another session.
