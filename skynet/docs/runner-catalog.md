# Skynet — Runner Catalog (coding-agent candidates to wrap)

Candidate coding agents to expose through the `runner-sdk` (the "wrap, don't rebuild" breadth play —
see [positioning.md](positioning.md)). Tiered by **how well they fit Skynet's model**, which is: we
spawn the agent in a sandboxed container, feed it a task in a git worktree, surface its native
permission/HITL prompts, and capture its diffs/output.

Status: ✅ adapter exists · ⭐ high-priority next · ◻ candidate. Each entry needs a headless/automatable
mode confirmed before committing — treat this as a research list, not a promise.

---

## Tier 1 — Headless / CLI agents (best fit: we spawn them in a container)
These run as a command-line process we can drive non-interactively. Ideal `runner-sdk` targets.

| Agent | Vendor | Notes |
|---|---|---|
| **Claude Code** | Anthropic | ✅ via Agent SDK (headless Claude Code) |
| **Codex CLI** | OpenAI | ✅ adapter |
| **Gemini CLI** | Google | ✅ adapter |
| **Cursor Agent / Cursor CLI** | Cursor | ✅ adapter (CLI + background agents) |
| **Copilot CLI / coding agent** | GitHub | ✅ adapter |
| **OpenCode** | open source | ✅ adapter — provider-agnostic terminal agent; **ubiquitous** across the competitor field |
| **Aider** | open source | ✅ adapter — headless via `--message`/`--yes-always`; **not yet live-verified** (no real install/key available when it landed), and `--yes-always` doesn't auto-run shell commands the model proposes ([issue #3903](https://github.com/Aider-AI/aider/issues/3903), open) — edits land, commands don't |
| **OpenHands** (ex-OpenDevin) | open source | ⭐ headless agent runtime; strong fit |
| **Goose** | Block | ⭐ open-source CLI agent, MCP-native |
| **Amp** | Sourcegraph | ⭐ CLI agent |
| **Crush** | Charm | ◻ OSS TUI coding agent, rising |
| **Antigravity** (`agy`) | Google | ◻ agentic IDE/CLI; appears in claw / CCC adapters |
| **Auggie CLI** | Augment | ◻ Augment's CLI agent (distinct from the IDE in Tier 3) |
| **Qwen Code** | Alibaba | ◻ model-vendor coding CLI |
| **Grok CLI** | xAI | ◻ model-vendor coding CLI |
| **Kimi Code** | Moonshot | ✅ adapter ([MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)) — native single-binary install, Kimi models by default, config-switchable to Anthropic/OpenAI |
| **SWE-agent** | Princeton | ◻ research-grade, CLI, good for benchmarks |
| **Plandex** | open source | ◻ CLI, plan-based long tasks |
| **gptme** | open source | ◻ terminal agent |
| **Open Interpreter** | open source | ◻ general code-exec agent (broad, less repo-focused) |
| **Codebuff** | Codebuff | ◻ CLI |
| **Mentat** | open source | ◻ CLI editor agent |
| **Refact.ai** | open source | ◻ self-hostable agent |
| **Factory "Droids"** | Factory.ai | ⭐ CLI droids; in wide orchestrator use |
| **Warp Agent** | Warp | ◻ terminal-native agent mode |
| **Qodo** (ex-Codium) | Qodo | ◻ agentic, test-generation focus |

## Tier 2 — API / platform / async agents (run on the vendor's infra; integrate via API + webhook)
We don't spawn these in our containers; we **call their API and receive results** (often a PR). Overlaps
with the "triggers & integrations" theme — they behave like a delegated remote worker.

| Agent | Vendor | Notes |
|---|---|---|
| **Devin** | Cognition | ⭐ has a Devin API; async remote engineer |
| **Jules** | Google | async coding agent, GitHub-based |
| **Replit Agent** | Replit | platform-hosted |
| **Codegen** | codegen.com | agentic, API-driven |
| **Sweep** | Sweep | GitHub PR bot |
| **Augment Agent** | Augment | hosted agent |
| **Cosine "Genie"** | Cosine | hosted SWE agent |
| **Zencoder** | Zencoder | hosted |
| **Tembo / Sourcery / etc.** | various | review/refactor-as-a-service |

## Tier 3 — IDE-first agents (harder to run headless; lower priority)
Primarily editor extensions; wrappable only if/when they expose a headless mode.
**Cline**, **Roo Code**, **Kilo Code**, **Continue**, **Tabnine**, **Windsurf/Cascade (Codeium)**,
**Zed agent**, **JetBrains AI / Junie**, **Augment (IDE)**, **Kiro (AWS)**.

## Tier 4 — Agent *frameworks/SDKs* (build-your-own — against "wrap, don't rebuild")
Not off-the-shelf agents; toolkits for *building* one. Use **only** if a needed specialized agent
doesn't exist off-the-shelf. Listed for awareness, deliberately low priority:
**OpenAI Agents SDK**, **Anthropic Agent SDK** (already the Claude path), **LangGraph**, **AutoGen**
(Microsoft), **CrewAI**, **Google ADK**, **AWS Strands**, **Mastra**, **Pydantic AI**,
**Vercel AI SDK**, **smolagents** (HF), **LlamaIndex agents**.

---

## How we'll add them
> **Demand signal (competitor sweep, 2026):** the orchestrator *Agent Orchestrator* ships adapters for **23
> harnesses** — a real-world map of which agents matter. Cross-referencing it drove the ⭐ picks above
> (OpenCode, Aider, Goose, Amp, Droid lead by usage). Breadth is commodity — prioritize by that signal + user demand.

- **Reactively + by fit:** Tier 1 first (cleanest container-spawn), then Tier 2 where a vendor's API
  is compelling (Devin, Jules). Add on real user demand — breadth is commodity, not a sprint.
- **One adapter per agent**, behind the existing `runner-sdk` (`packages/runner-sdk/src/<vendor>.ts`),
  selected by `RUNNER=<vendor>`. Tier 2 adapters are API clients rather than container-spawners.
- **Keep adapters thin** — surface the vendor's native HITL/permission prompts; don't inject our own
  agent logic. This is what keeps us robust to their updates and the value in Skynet's layers.
- Every adapter automatically gains: workspace scoping, HITL Inbox, merge queue, conflict families,
  portable memory, and audit — for free.
