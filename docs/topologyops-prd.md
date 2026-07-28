# Product Requirements Document (PRD)

**Project Name:** TopologyOps Middleware
**Target Audience:** Core AI Infrastructure & Systems Engineers
**Version:** 0.1.0-alpha
**Status:** Research prototype specification
**Supersedes:** v1.0.0 Draft (see §13 for what changed and why)

---

## 1. Executive Overview

TopologyOps is a runtime control plane that sits between an LLM orchestration layer
(LangGraph, AutoGen, or a custom gRPC agent framework) and multi-agent application
logic. It observes inter-agent message traffic, detects two specific well-documented
failure modes, and emits discrete corrective directives back to the runtime.

The two failure modes in scope for v0.1:

1. **Context bloat** — transcripts grow monotonically as a swarm works, so every
   subsequent LLM call pays for history that is no longer decision-relevant.
2. **Stagnation loops** — agents converge into mutual agreement and continue
   exchanging turns that introduce no new information, burning tokens and
   entrenching whatever the group already believed.

Both are cheap to detect from the message stream alone. Neither requires spectral
graph theory, and v0.1 deliberately does not use any.

### 1.1 What this version is

This is a **hypothesis-testing prototype with a measurement harness**, not a 1.0
product. The predecessor document committed to KPIs (35% token reduction, 25%
consensus latency improvement) that had no derivation behind them and no
instrumentation capable of confirming them. This version inverts the order: build
the ability to measure the effect first, then build the smallest intervention that
could plausibly produce it, then decide whether the ambitious version is warranted.

### 1.2 Falsifiable hypotheses

Each hypothesis states a mechanism, a predicted effect, and the condition that
would falsify it. None is a committed KPI; all are experiments.

| ID | Hypothesis | Falsified if |
|---|---|---|
| **H1** | Replacing completed-subtask transcripts with summaries reduces total input tokens per run by ≥20% on the reference benchmark. | Measured reduction < 20%, or CI for the paired difference includes 0. |
| **H2** | H1's token reduction does not degrade task success rate by more than 2 percentage points. | Success-rate regression > 2pp at p < 0.05. |
| **H3** | Stagnation-loop detection followed by auditor injection reduces mean turns-to-completion on tasks that exhibit loops, relative to no intervention. | No detectable reduction, or intervention increases turn count. |
| **H4** | The end-to-end intervention is net-cheaper than an LLM-supervisor baseline, after accounting for the middleware's own embedding and summarization spend. | Total cost (§11) ≥ supervisor baseline. |

H4 is the one most likely to fail and is the one the predecessor document never
examined. See §11.

---

## 2. Scope

### 2.1 In scope for v0.1

- Passive instrumentation of inter-agent message traffic (**FR-1**)
- Transcript compaction on subtask completion (**FR-2**)
- Stagnation-loop detection and auditor injection (**FR-3**)
- A discrete directive protocol with a safety governor (**FR-4**)
- A benchmark harness capable of resolving a 20% effect against run-to-run
  variance (**P0**, §5)

### 2.2 Explicitly out of scope for v0.1

| Deferred | Reason | Entry criteria (§7) |
|---|---|---|
| Spectral routing / λ₂ optimization | The theorem motivating it does not apply to LLM agents (§7.1). | H1–H4 resolved; benchmark can resolve a 15% effect; a defensible objective replaces λ₂. |
| Graph grammars / live node splitting | The hard part is live state migration, not the grammar. | Compaction shipped; state-handoff primitive exists and is tested. |
| Swarms above ~30 agents | No production workload at this size; premature. | A real workload exists at N > 30. |

Deferral is not rejection. §7 records what each would need to become viable so the
work is resumable rather than lost.

---

## 3. Architecture

TopologyOps observes messages, maintains a rolling window of derived signals,
and emits discrete directives. It never rewrites message content in v0.1.

```
   ┌─────────────────────────────────────────────────────────────┐
   │                  Multi-Agent Swarm Runtime                   │
   └──────────────┬──────────────────────────────▲───────────────┘
                  │ Message tap (observe-only)   │ Discrete directives
                  │ gRPC / JSON-RPC              │ (TTL'd, reversible)
                  ▼                              │
   ┌─────────────────────────────────────────────────────────────┐
   │                     TopologyOps Engine                      │
   │                                                             │
   │  ┌───────────────────────┐      ┌────────────────────────┐  │
   │  │  Message Instrument   │      │  Rolling Signal Window  │  │
   │  │  (FR-1)               │─────►│  novelty / similarity   │  │
   │  └───────────────────────┘      │  / ledger delta         │  │
   │                                 └───────────┬────────────┘  │
   │  ┌──────────────────────────────────────────▼────────────┐  │
   │  │                   Detectors                            │  │
   │  │   • Subtask-completion detector  (FR-2)                │  │
   │  │   • Stagnation detector w/ hysteresis (FR-3)           │  │
   │  └──────────────────────────────────┬─────────────────────┘  │
   │  ┌──────────────────────────────────▼─────────────────────┐  │
   │  │        Safety Governor → Directive Emitter (FR-4)      │  │
   │  │   rate limit · dwell time · TTL · shadow mode · kill   │  │
   │  └────────────────────────────────────────────────────────┘  │
   └─────────────────────────────────────────────────────────────┘
```

### 3.1 Deployment modes

The engine ships with three modes. **Shadow is the default** and is the mode in
which all v0.1 hypothesis data is collected.

| Mode | Behavior | Purpose |
|---|---|---|
| `off` | Tap disabled entirely. | Kill switch. |
| `shadow` | Detects and logs directives; the runtime **does not apply them**. | Collect detector precision/recall and counterfactual cost data at zero risk. |
| `active` | Directives are applied by the runtime. | Live operation, after shadow-mode validation. |

Shadow mode is what makes the hypotheses testable cheaply: it yields the full
detector timeline on real traffic before anything is allowed to change behavior.

---

## 4. Design constraints derived from the v1.0.0 review

These are cross-cutting and bind every FR below.

**C-1 — Directives must be discrete.** The engine may not emit a real-valued
weight as an action. "Dampen edge weight to `w · 0.2`" has no operational meaning
to an LLM runtime: a conversation cannot be multiplied by 0.2. Every directive
resolves to something the runtime can literally execute — deliver a message or
don't, include a span in context or don't, instantiate an agent or don't.

**C-2 — Topology is authored, not emergent.** In real LangGraph/AutoGen
applications the edges are code paths the developer wrote. The engine may
*suppress* an authored edge, but it may not invent one, because a new edge
requires the source agent's prompt and tool schema to change so it knows the
target exists and what to say to it. Prompt rewriting is out of scope for a
middleware layer.

**C-3 — Every mutation is reversible and TTL'd.** The engine is a controller
acting on a plant whose behavior changes the measurements driving the controller.
Without dwell time and hysteresis this loop oscillates. See FR-4.2.

**C-4 — Detectors use sustained scores, not threshold conjunctions.** A
conjunction of three independently tuned thresholds fires never or always. All
detectors compute a single normalized score and require it to persist across a
window.

**C-5 — Tests validate outcomes, not mechanism.** A test asserting that the
engine emitted `INJECT_AGENT` passes on a system that makes the swarm worse. See
§10.

---

## 5. P0: Measurement harness (first deliverable)

**This ships before any detector.** Multi-agent runs are high-variance: the same
swarm on the same task varies substantially in token count and outcome between
runs. Without a harness that can resolve the effect sizes in §1.2 against that
noise floor, no hypothesis can be confirmed or denied and every later number is
unfalsifiable.

### P0-1 Reference benchmark

- **≥40 tasks** across at least three task families (multi-step research,
  code modification with tests, structured extraction/reconciliation).
- Each task has a **programmatic success check** — no LLM-as-judge in the primary
  metric, because a judge introduces its own variance and its own cost into the
  thing being measured.
- At least one family is **seeded to induce stagnation loops** (e.g. an
  underspecified task with no reachable ground truth), because H3 cannot be
  tested on tasks that never loop.

### P0-2 Variance characterization

Before any intervention exists, run the unmodified swarm **n ≥ 20 times per task**
and publish the per-task and aggregate distributions of:

- total input tokens, total output tokens, total cost
- wall-clock time to completion
- turn count
- success rate

**Gate:** the harness is complete only when the 95% CI half-width on aggregate
token count is **< 10%** of the mean. If it is wider, the effects in §1.2 are not
measurable and the benchmark must be enlarged before proceeding.

### P0-3 Paired evaluation protocol

- Comparisons are **paired by task and seed** — same task, same model, same
  temperature, same tool fixtures, arms differing only in the intervention.
- Report **effect size with a confidence interval**, not point estimates.
- Tool responses are recorded and replayed from fixtures so that external service
  variance does not enter the comparison.
- Every reported result names its n, its CI, and its benchmark commit SHA.

### P0-4 Cost accounting

The harness meters **all** LLM and embedding spend, including the middleware's
own (§11). A token reduction that ignores the engine's embedding and
summarization calls is not a result.

---

## 6. Functional Requirements

### FR-1 — Message instrumentation (passive)

- **FR-1.1** The engine shall tap inter-agent messages via the runtime's existing
  message bus, recording: sender, recipient(s), timestamp, token count, tool
  calls invoked, and message body reference.
- **FR-1.2** For each message the engine computes and stores a **novelty vector**:
  - `sim_self` — max cosine similarity between this message and the sender's own
    previous *k* messages (default k = 5).
  - `sim_peer` — max cosine similarity between this message and any other agent's
    messages within the rolling window.
  - `tool_delta` — count of tool invocations in this message not seen in the
    window.
  - `ledger_delta` — count of writes to the shared task ledger / scratchpad
    attributable to this message.
- **FR-1.3** Embeddings are computed with a small local or hosted embedding model.
  The engine shall cache by content hash; repeated identical content costs
  nothing.
- **FR-1.4** The tap is **strictly observe-only**. FR-1 introduces no directives
  and no runtime behavior change, and must be independently deployable.

> **Note on FR-1.2:** the predecessor's weight formula
> `w_ij = α · f(frequency) + (1−α) · cos(e_i, e_j)` was underspecified — `f` was
> never defined and the resulting scalar was never consumed by an action that
> could use a real number (C-1). The novelty vector replaces it with named
> signals that feed named detectors.

### FR-2 — Transcript compaction on subtask completion

This is where the token savings in H1 are expected to come from. It is
context compaction, and it is deliberately not described as graph coarsening —
the operation is the same and the name adds no capability.

- **FR-2.1 Completion detection.** A subtask is considered complete when **either**
  an explicit runtime completion signal is received (preferred, and the only
  trigger enabled by default), **or** the participating agents' `ledger_delta`
  sums to zero across a window of `W_complete` turns (default 4) while a ledger
  entry for that subtask is marked resolved.
- **FR-2.2 Compaction.** On completion of subtask *S* with participating agents
  `V_S`:
  1. Generate a summary of `V_S`'s transcript spans for *S*, bounded to
     `max_summary_tokens` (default 800).
  2. The summary must preserve, verbatim where possible: decisions reached,
     artifacts produced with their identifiers, unresolved questions, and any
     numeric results.
  3. Replace those spans in **future** context assembly with the summary.
- **FR-2.3 The original transcript is never deleted.** Compaction affects context
  assembly only. Full history remains queryable for audit and for the harness's
  counterfactual accounting.
- **FR-2.4 Reversibility.** A `RESTORE_SPANS` directive re-expands a compacted
  region if a later agent's query cannot be served from the summary. The engine
  logs every restore — a high restore rate is direct evidence that
  `max_summary_tokens` is too aggressive.
- **FR-2.5 Fidelity gate.** Compaction is enabled per-swarm only after passing
  the fidelity check in §10 (T-2).

### FR-3 — Stagnation-loop firewall

Detects agents converging into mutual agreement that produces no new information.
This targets a real failure mode; the detection is intentionally cheap.

- **FR-3.1 Stagnation score.** Over a rolling window of `W_stag` turns
  (default 6), compute a single normalized score:

  $$S = w_1 \cdot \overline{sim_{self}} + w_2 \cdot \overline{sim_{peer}} + w_3 \cdot \mathbb{1}[\Sigma\, tool\_delta = 0] + w_4 \cdot \mathbb{1}[\Sigma\, ledger\_delta = 0]$$

  with $\Sigma w_i = 1$, defaults `w = (0.25, 0.25, 0.25, 0.25)`. Weights are
  configurable and are to be fit on shadow-mode data, not guessed.

- **FR-3.2 Schmitt-trigger firing (C-4).** The detector fires when
  `S > θ_hi` (default 0.80) for `D_stag` **consecutive** turns (default 3). It
  clears only when `S < θ_lo` (default 0.60). `θ_lo < θ_hi` is enforced at config
  load. A single instantaneous threshold crossing never fires anything.

- **FR-3.3 Interventions.** On firing, in escalation order:
  1. **`INJECT_AGENT(role=auditor)`** — instantiate an auditor agent with a
     contrarian system prompt, seeded with the compacted subtask context and
     instructed to produce a concrete alternative hypothesis or an explicit
     falsification attempt. This is the primary intervention.
  2. **`SUPPRESS_EDGE(u, v, ttl)`** — hard-mute an authored edge for `ttl` turns
     (C-1: a discrete mute, not a weight multiplier). Applied only if the auditor
     fires twice on the same cluster without the score clearing.
  3. **`ESCALATE_TO_HUMAN`** — if the score does not clear after both
     interventions, stop intervening and surface it. The engine does not keep
     escalating on its own.

- **FR-3.4 No clustering in v0.1.** The predecessor specified Louvain modularity
  or spectral clustering to find dense subgraphs. At typical swarm sizes
  (§8, N = 3–30) there is nothing to cluster — the participant set of a
  stagnating exchange is read directly from the message window. Clustering
  becomes worth revisiting at N > 30 (§7.2).

### FR-4 — Directive protocol and safety governor

- **FR-4.1 Discrete directives only (C-1).** The complete v0.1 action set is
  `COMPACT_SPANS`, `RESTORE_SPANS`, `INJECT_AGENT`, `SUPPRESS_EDGE`,
  `ESCALATE_TO_HUMAN`, `NO_OP`. There is no `ADD_EDGE` (C-2) and no weight-valued
  action.

- **FR-4.2 Governor (C-3).** Every directive passes through a governor enforcing:
  - **Rate limit** — at most one behavior-changing directive per `R_min` turns
    (default 5) per swarm.
  - **Dwell time** — a directive may not be reversed within `T_dwell` turns
    (default 10). This is what prevents the add/prune oscillation that the
    predecessor's FR-2.3 built directly into its own control law.
  - **TTL** — every `SUPPRESS_EDGE` and `INJECT_AGENT` carries a TTL and
    **auto-reverts** on expiry. Nothing is permanent by default.
  - **Budget cap** — the engine's own cumulative spend may not exceed
    `max_overhead_pct` (default 10%) of the swarm's spend for the run. On breach
    the engine drops to `shadow`.
  - **Circuit breaker** — if directives fire more than `max_directives_per_run`
    (default 8), the engine drops to `shadow` and logs. Frequent firing means the
    detector is miscalibrated, and a miscalibrated controller should stop acting.

- **FR-4.3 Idempotency and audit.** Every directive carries a stable ID, the
  detector state that produced it, and the governor decision. Re-delivery is a
  no-op. The full directive log is a first-class output.

---

## 7. Deferred work and entry criteria

### 7.1 Spectral routing (predecessor FR-2)

**Why deferred.** Algebraic connectivity λ₂ governs convergence rate in *linear
consensus dynamics* — ẋ = −Lx, nodes repeatedly averaging scalar state with
neighbors in synchronous rounds. Under that model convergence really is
O(1/λ₂); it is a theorem. LLM agents satisfy none of its premises: they do not
average, they have no linearly-mixing state vector, messages are asynchronous and
semantically typed, and a single message can influence a peer more than fifty
others. λ₂ remains well-defined on the graph — it is simply no longer connected to
the quantity it was named for. The predecessor's "≥25% faster consensus" followed
from the analogy, not from the mathematics.

Three further defects, recorded so they are not reintroduced:

1. **The edge-selection rule was wrong.** The predecessor connected the pair at
   the *maximum entry* of the Fiedler vector. The max entry identifies one node,
   not a pair; and the top-2 entries lie on the *same* side of the spectral cut,
   so joining them barely moves λ₂. The first-order gain from adding edge (u,v)
   of weight w is `w · (v₂ᵤ − v₂ᵥ)²`, so the correct rule maximizes the
   *difference* — most-positive against most-negative entry, i.e. opposite sides
   of the cut.
2. **Determinism was unachievable as specified.** A fixed Lanczos seed does not
   give determinism when threaded BLAS reductions are non-associative in floating
   point. Worse, Fiedler-vector conditioning goes as `1/(λ₃ − λ₂)`; on the
   near-symmetric topologies swarms produce constantly, a negligible weight change
   rotates the eigenvector into a different basis and the selected node pair
   changes completely. **The spectral gap was never mentioned in the predecessor
   document**, and it is the quantity that decides whether any of this is stable.
3. **λ₂ may be the wrong invariant even within graph theory.** Token cost tracks
   path length and fan-out far more directly. Average shortest path, effective
   resistance, or plain maximum fan-out are more interpretable and map onto
   messages-actually-sent.

**Entry criteria.** Revisit only when: (a) H1–H4 are resolved; (b) the benchmark
resolves a 15% effect; (c) a defensible objective replaces λ₂ — most likely
expected messages-to-information-propagation, measured empirically rather than
assumed; (d) C-2 is solved, i.e. there is a mechanism by which a newly added edge
actually changes the source agent's prompt and tool schema.

### 7.2 Graph grammars and live node splitting (predecessor FR-5)

**Why deferred.** The grammar formalism was the easy part and got the most detail;
the hard part got none. Splitting a live agent means migrating conversation state,
in-flight messages addressed to the original, and open tool handles or
connections to its replacements. That is process migration. The trigger
`task_complexity_score > 0.85` was also undefined, and it is the crux of the
feature.

**Entry criteria.** (a) FR-2 shipped and validated, since compaction already
provides the state-summarization primitive splitting needs; (b) a specified,
tested state-handoff mechanism with defined semantics for in-flight messages;
(c) `task_complexity_score` defined and shown to correlate with an outcome worth
acting on.

### 7.3 Large-N support

The predecessor targeted N = 250–1000 nodes. Production multi-agent systems
overwhelmingly run 3–20 agents. At N = 10, λ₂ is a nearly meaningless statistic
and modularity clustering has nothing to cluster. Note also that the predecessor's
performance NFRs described the *easy* problem — λ₂ via Lanczos on a 250×250 matrix
is a few milliseconds, comfortably inside a 15 ms budget. Hard numbers were given
for the tractable part and prose for the hard parts. Revisit when a real workload
exists above N = 30.

---

## 8. Non-Functional Requirements

Sized to the workloads that actually exist, and stated so that failure is
detectable.

| Category | Requirement | Target |
|---|---|---|
| **Scale** | Supported swarm size | N = 3–30 agents. Above 30: degrade to observe-only, log a warning. |
| **Latency** | Added latency per message, p99 | < 5 ms excluding embedding I/O; embeddings are computed **off the critical path** and a message is never blocked on one. |
| **Latency** | Detector evaluation, p99 | < 20 ms, executed asynchronously against the rolling window. |
| **Overhead** | Engine spend as fraction of swarm spend | < 10% (enforced by FR-4.2 budget cap, not merely aspirational). |
| **Memory** | Per-swarm resident state | < 50 MB for N ≤ 30 with a 200-turn window; embeddings stored at fp16, window-bounded, evicted by LRU. |
| **Availability** | Engine failure behavior | **Fail open.** Engine unavailability degrades to passthrough; the swarm continues unmodified. A control plane must never be able to take down the data plane. |
| **Determinism** | Reproducibility | Given an identical message log and config, the directive sequence is byte-identical. Achieved by avoiding iterative eigensolvers entirely — v0.1 has no operation with floating-point-associativity sensitivity in a decision path. |
| **Interop** | Frameworks | LangGraph, AutoGen 0.4+, raw gRPC/REST. Adapters are thin and each ships with a conformance test. |

---

## 9. Interface Specification

```protobuf
syntax = "proto3";

package topologyops.v1;

service TopologyEngine {
  // Streamed observation — the engine consumes messages as they flow.
  rpc ObserveMessages (stream MessageEvent) returns (stream Directive);

  // Explicit lifecycle signals from the runtime. Preferred over inference.
  rpc SignalSubtaskComplete (SubtaskCompleteRequest) returns (Ack);

  // Operational control.
  rpc SetMode (SetModeRequest) returns (Ack);
  rpc GetRunReport (RunReportRequest) returns (RunReport);
}

message MessageEvent {
  string swarm_id     = 1;
  string message_id   = 2;
  string sender_id    = 3;
  repeated string recipient_ids = 4;
  int64  ts_unix_ms   = 5;
  int32  token_count  = 6;
  repeated string tool_calls  = 7;
  repeated string ledger_writes = 8;
  string body_ref     = 9;   // reference, not the body: the engine does not need it
  string subtask_id   = 10;
}

message SubtaskCompleteRequest {
  string swarm_id = 1;
  string subtask_id = 2;
  repeated string participant_ids = 3;
}

message Directive {
  enum ActionType {
    ACTION_UNSPECIFIED  = 0;
    COMPACT_SPANS       = 1;  // FR-2
    RESTORE_SPANS       = 2;  // FR-2.4
    INJECT_AGENT        = 3;  // FR-3.3
    SUPPRESS_EDGE       = 4;  // FR-3.3 — a hard mute, not a weight
    ESCALATE_TO_HUMAN   = 5;  // FR-3.3
    NO_OP               = 6;
  }
  string     directive_id = 1;   // stable; re-delivery is idempotent
  ActionType action       = 2;
  string     swarm_id     = 3;
  repeated string target_ids = 4;
  int32      ttl_turns    = 5;   // 0 = not applicable; required for 3 and 4
  DetectorState evidence  = 6;   // why this fired — always populated
  bool       shadow       = 7;   // true = advisory only, do not apply
}

message DetectorState {
  string detector       = 1;   // "stagnation" | "subtask_completion"
  float  score          = 2;
  float  theta_hi       = 3;
  float  theta_lo       = 4;
  int32  turns_above    = 5;
  repeated string contributing_message_ids = 6;
}

message RunReport {
  string swarm_id            = 1;
  int64  swarm_input_tokens  = 2;
  int64  swarm_output_tokens = 3;
  int64  engine_embed_tokens = 4;   // the engine's own spend, always reported
  int64  engine_llm_tokens   = 5;
  int32  directives_emitted  = 6;
  int32  directives_applied  = 7;
  int32  restores            = 8;   // high value ⇒ compaction too aggressive
  float  overhead_pct        = 9;
}

message Ack { bool ok = 1; string detail = 2; }
message SetModeRequest { string swarm_id = 1; string mode = 2; } // off|shadow|active
message RunReportRequest { string swarm_id = 1; }
```

Two deliberate changes from the predecessor interface: the engine receives a
**stream of message events** rather than a whole-graph snapshot (it does not need
`GraphStateRequest`'s full node and edge lists, and asking for them each turn is
gratuitous), and `RunReport` makes the engine's own token spend a first-class
part of the protocol so H4 can never be quietly skipped.

---

## 10. Verification and Validation

Two tiers. Mechanism tests are necessary but prove nothing about value (C-5);
outcome tests are the ones that decide whether the project continues.

### 10.1 Tier 1 — Mechanism (necessary, not sufficient)

| ID | Requirement | Test | Acceptance |
|---|---|---|---|
| M-1 | FR-1 | Replay a recorded 200-message log. | Novelty vectors byte-identical across 3 runs; tap adds < 5 ms p99; zero behavior change vs. control. |
| M-2 | FR-3.2 | Feed a synthetic score trace oscillating across `θ_hi`. | Fires only after `D_stag` consecutive turns above `θ_hi`; clears only below `θ_lo`; zero fires on single-turn spikes. |
| M-3 | FR-4.2 | Emit 50 directives in 10 turns. | Governor admits ≤ 1 per `R_min`; circuit breaker trips at `max_directives_per_run`; mode drops to `shadow`. |
| M-4 | NFR fail-open | Kill the engine mid-run. | Swarm completes; output identical to no-engine control. |
| M-5 | FR-2.4 | Compact a span, then query a fact present only in the original. | `RESTORE_SPANS` issued; query answered correctly. |

### 10.2 Tier 2 — Outcome (these decide the project)

All Tier 2 results use the P0-3 paired protocol, report effect size with CI, and
count engine spend per P0-4.

| ID | Hypothesis | Test | Acceptance |
|---|---|---|---|
| **T-1** | H1 | Full benchmark, compaction on vs. off, n ≥ 20 paired runs per task. | Total input-token reduction ≥ 20%, CI excludes 0. |
| **T-2** | H2 (fidelity gate) | Same runs as T-1. | Success-rate regression ≤ 2pp; restore rate < 5% of compactions. **Blocks FR-2.5.** |
| **T-3** | H3 | Loop-seeded task family, auditor injection on vs. off, n ≥ 20 paired. | Mean turns-to-completion strictly lower with intervention, CI excludes 0. |
| **T-4** | H3 (precision) | Shadow-mode traces hand-labeled for genuine stagnation. | Detector precision ≥ 0.7 at recall ≥ 0.5. Below this the intervention fires on healthy exchanges and T-3 is uninterpretable. |
| **T-5** | H4 | All arms, full cost accounting per §11. | Total cost < LLM-supervisor baseline on the same benchmark. |
| **T-6** | Stability | 50 long-horizon runs in `active` mode. | Zero oscillation events (defined as a directive and its reversal within `2 · T_dwell`); zero circuit-breaker trips attributable to detector thrash. |

Note what T-4 exists to prevent: without it, a detector that fires on every
exchange would "pass" T-3 by injecting auditors constantly, and the result would
be meaningless.

---

## 11. Cost model

The predecessor positioned the engine as replacing "costly LLM-based supervisors"
while requiring an embedding of recent context after every message (FR-1.2),
semantic agreement metrics (FR-3.2), and summarization (FR-4.2). That is one
embedding call per message plus periodic LLM summarization — not obviously cheaper
than the supervisor it replaces. The claim was asserted, never computed. H4 tests
it, and this section defines the arithmetic the harness implements.

For a run of `M` messages, `T` turns, and `K` compaction events:

```
Baseline (supervisor):   C_base   = T · (c_in · s_ctx + c_out · s_out)
Swarm (uncompacted):     C_swarm  = Σ_t (c_in · ctx_t + c_out · out_t)
Engine overhead:         C_engine = M · c_embed · len_msg
                                  + K · (c_in · span_len + c_out · summary_len)
Swarm (compacted):       C_comp   = Σ_t (c_in · ctx'_t + c_out · out_t)
```

The engine is worth running iff `C_comp + C_engine < min(C_swarm, C_swarm + C_base)`.

Two structural observations that should shape expectations:

- **Embedding cost is near-negligible; summarization cost is not.** Embeddings run
  two to three orders of magnitude cheaper per token than frontier generation, so
  `M · c_embed · len_msg` is rounding error. The real overhead is
  `K` summarization calls, which is why `max_summary_tokens` and compaction
  frequency are the parameters that decide H4.
- **Savings are superlinear in run length.** Uncompacted context grows roughly
  linearly in turns, so uncompacted cost grows roughly quadratically. Compaction's
  advantage therefore widens on long runs and may be *negative* on short ones. The
  harness must report the break-even turn count, and the engine should not compact
  below it. A single aggregate percentage would hide this entirely.

---

## 12. Risks and kill criteria

Stating in advance what would make this not worth continuing.

| Risk | Mitigation | Kill criterion |
|---|---|---|
| Benchmark cannot resolve the effect | P0-2 gate before any detector is built | CI half-width stays > 10% of mean after benchmark expansion → stop; the question is unanswerable as posed |
| Compaction loses decision-relevant context | FR-2.4 restore, T-2 fidelity gate | Restore rate > 15%, or success regression > 2pp that tuning cannot close |
| Stagnation detector has no signal | Fit weights on shadow data rather than guessing | T-4 precision < 0.5 at any usable recall after fitting |
| Overhead exceeds savings | FR-4.2 budget cap; §11 accounting | T-5 fails and sensitivity analysis shows no parameter region where it passes |
| Frameworks add native compaction | Shadow mode makes the engine cheap to abandon | Upstream ships equivalent compaction and it matches our T-1 result → contribute upstream instead |
| Controller destabilizes swarms | Hysteresis, dwell, TTL, circuit breaker, shadow default | T-6 shows oscillation that tuning cannot eliminate |

The framework-convergence risk deserves emphasis: context compaction is an
obvious feature and orchestration frameworks are actively building it. If FR-2's
value is confirmed and upstream ships the same thing, contributing there is a
better outcome than maintaining a separate control plane for it.

---

## 13. Changes from v1.0.0

| Predecessor | Disposition | Rationale |
|---|---|---|
| KPIs: 35% tokens, 25% consensus latency, < 15 ms | → falsifiable hypotheses H1–H4 (§1.2) | The numbers had no derivation and no instrumentation could confirm them. |
| FR-1 adjacency/degree matrices, weight formula | → FR-1 novelty vector | `f(frequency)` was undefined; the resulting scalar fed no action that could consume a real number (C-1). |
| FR-2 λ₂ optimization | **Deferred** (§7.1) | Consensus theorem does not transfer; edge-selection rule was incorrect; determinism unachievable as specified; C-2 unaddressed. |
| FR-3 echo-chamber firewall | **Kept, simplified** → FR-3 | Real failure mode. Clustering dropped (nothing to cluster at N ≤ 30); three-way threshold conjunction replaced by a sustained score with hysteresis (C-4); the `w → w · 0.2` action replaced by a discrete mute (C-1). |
| FR-4 graph coarsening | **Kept, renamed** → FR-2 | This is context compaction and is where the token savings live. The spectral framing added a name, not a capability — note that the predecessor's headline 35% was achievable with zero spectral machinery. |
| FR-5 graph grammars | **Deferred** (§7.2) | Grammar was the easy part and got all the detail; live state migration is the hard part and got none. |
| NFRs: N = 250–1000 | → N = 3–30 (§8) | No production workload at the stated scale; and the stated latency targets described the tractable half of the problem. |
| §6 test matrix | → §10 two-tier, outcome-gated | Every original test passed on a system that degrades swarm performance. |
| — | **Added:** P0 measurement harness (§5) | Cannot confirm or deny any hypothesis without it. Ships first. |
| — | **Added:** shadow mode (§3.1) | Collects the evidence at zero risk; also the graceful-degradation target. |
| — | **Added:** safety governor (FR-4.2) | The predecessor's own control law contained an add/prune limit cycle with nothing between it and oscillation. |
| — | **Added:** cost model (§11), kill criteria (§12) | The "cheaper than a supervisor" claim was never computed; and a research prototype needs stated conditions for stopping. |
| Version 1.0.0 | → 0.1.0-alpha | Learned/optimized agent topology is an open research question, not settled infrastructure. Committing to 1.0 KPIs on it sets up the failure where tests go green and the KPIs never land. |

---

## 14. Roadmap

| Phase | Deliverable | Exit gate |
|---|---|---|
| **0** | Measurement harness (§5) | P0-2 variance gate met |
| **1** | FR-1 instrumentation, shadow mode | M-1, M-4 pass; ≥ 100 real runs of shadow traces collected |
| **2** | FR-2 compaction | T-1, T-2 pass |
| **3** | FR-3 stagnation firewall + FR-4 governor | T-3, T-4, T-6 pass |
| **4** | Cost validation | T-5 passes |
| **5** | Decision point | Review §7 entry criteria; either resume deferred work with a defensible objective, contribute upstream, or stop |

Phases 2 and 3 are independently valuable and independently shippable. Phase 5 is
a real decision point with "stop" as a legitimate outcome, not a formality.
