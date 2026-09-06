# Skynet — Integrations & Responder Agents (inbound work)

Candidates for the **Triggers & integrations** theme (ROADMAP v3). Each turns a signal from a tool the
team already uses into a **human-gated agent task** in Skynet.

> **Every integration uses the user's OWN account** (their OAuth/token), and the agent runs on the
> **user's own LLM key**. Skynet hosts none of these services and resells nothing — it's the
> connective + supervision layer: receive the signal → spin a supervised agent → act back into the
> user's tool → human approves. Mechanism = an **inbound-trigger** (webhook → task) + **scoped MCP
> tools** for the agent to act.
>
> **Security note on the scoped-MCP-tool half:** a write-capable server (e.g. a real GitHub PAT via a
> GitHub MCP server) lets an agent act **outside** Skynet's own git-operation guardrails — PR-only
> writes, no-force-push, the module allowlist — because those wrap Skynet's own git code path, not
> arbitrary MCP tool calls a runner CLI makes on the agent's behalf. This is a known, accepted tradeoff
> consistent with "the user's own account" above: Skynet supervises and surfaces the run, but a granted
> MCP tool's blast radius is whatever that tool's own credentials allow, not what Skynet's guardrails
> allow. The existing per-tool-call HITL approval gate (already governing browser MCP tool calls) is the
> mitigation — no separate runtime gate distinguishes an MCP tool call from any other tool call today.

Status: ⭐ high-value early · ◻ candidate. Pattern for each: **trigger → what the agent does → why include.**

**Shipped**: the generic custom-MCP-server config (add any stdio command or remote URL in Integrations,
grant it per project) and the Sentry inbound-trigger adapter — the concrete "GitHub / Sentry / Slack MCP"
proof case ROADMAP.md names. GitHub and Slack MCP servers work today the same way (paste the command/URL
in Integrations); they don't yet have a dedicated inbound-trigger adapter of their own (GitHub already has
one, via the pre-existing issues webhook — see ROADMAP-ARCHIVE.md).

## Code forges (where work originates — highest-frequency triggers)
| Integration | Trigger → action | Why include |
|---|---|---|
| **GitHub** ⭐ | issue labeled → PR · PR opened → review · comment command → task | Where most teams' code work lives; the densest source of triggers and the place results land |
| **GitLab** ◻ | same as GitHub on GL events | Cover the second-biggest forge |
| **Bitbucket** ◻ | same | Enterprise/Atlassian shops |

## Errors & observability (turn production signal into supervised fixes)
| Integration | Trigger → action | Why include |
|---|---|---|
| **Sentry** ✅ shipped | new error / regression → reproduce, root-cause, fix PR | The flagship "signal → fix" loop; high, visible value |
| **Datadog / Grafana / New Relic** ◻ | alert/monitor → triage + proposed fix | Broaden beyond exceptions to metrics/logs |

## Incident & on-call
| Integration | Trigger → action | Why include |
|---|---|---|
| **PagerDuty / Opsgenie** ⭐ | incident fires → gather context, draft mitigation + timeline | On-call is high-stakes and time-critical — supervised autonomy shines |

## Issue / project trackers (convert tracked work into agent work)
| Integration | Trigger → action | Why include |
|---|---|---|
| **Linear** ⭐ | issue → task → PR; status sync | Beloved by modern teams; clean API; "ticket → PR" is a killer demo |
| **Jira** ◻ | same | Enterprise reach |
| **Asana / Shortcut / Trello** ◻ | same | Breadth across PM tools |

## Chat (conversational entry + alerts out)
| Integration | Trigger → action | Why include |
|---|---|---|
| **Slack** ⭐ | slash command / mention → task; approvals + notifications pushed to a channel | Where teams already work; lowers the barrier to assign + lets HITL happen in-channel |
| **Teams / Discord** ◻ | same | Enterprise (Teams) and community/startup (Discord) |

## Support (bridge support → engineering)
| Integration | Trigger → action | Why include |
|---|---|---|
| **Zendesk / Intercom / Front** ◻ | ticket → reproduce + bug task, or draft reply | Turn customer pain directly into supervised fixes; strong ROI story |

## Security & dependencies (hygiene that nobody wants to do by hand)
| Integration | Trigger → action | Why include |
|---|---|---|
| **Dependabot / Snyk / GitHub Security / Socket** ⭐ | CVE / vulnerable dep → upgrade + fix the breakage → PR | Recurring, well-scoped, high-trust automation; great "set it and supervise" wins |

## CI (keep the pipeline green)
| Integration | Trigger → action | Why include |
|---|---|---|
| **GitHub Actions / CircleCI / Jenkins / Buildkite** ⭐ | build/test fails → diagnose logs + fix → PR | Failures are unambiguous triggers with a clear success signal |

## Scheduled / proactive
| Integration | Trigger → action | Why include |
|---|---|---|
| **Cron / scheduler** ◻ | time-based → recurring maintenance (dep bumps, changelog, doc refresh, stale-branch cleanup) | Proactive upkeep without anyone remembering to ask |

## Docs & design (specs as a source of work)
| Integration | Trigger → action | Why include |
|---|---|---|
| **Notion / Confluence / Google Docs** ◻ | spec/doc change → tasks; keep docs in sync with code | Docs-as-spec → implementation; keeps knowledge current |
| **Figma** ◻ | design change → implement/update UI | Design→code loop (more speculative; high wow-factor) |

## Generic
| Integration | Trigger → action | Why include |
|---|---|---|
| **Inbound webhook / email** ⭐ | any external event → task | The escape hatch — supports anything we haven't built a first-class connector for |

---

## Sequencing
Lead with the **⭐** set — they're the densest triggers and the most legible demos: **GitHub, Sentry,
Linear, Slack, Dependabot/Snyk, CI, generic webhook**. Each is built as a thin **inbound-trigger
adapter** (webhook → task in a workspace) plus a **scoped MCP tool** for the agent to act back — all
on the user's own credentials. Everything downstream (HITL Inbox, runners, merge, memory, audit) is
reused unchanged.
