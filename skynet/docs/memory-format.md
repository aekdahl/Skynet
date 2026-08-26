# The Skynet Open Memory Format

> **Status: Draft, spec v0.1.** This document defines the *file format* only — a
> versioned, human-readable, git-committable way to store accumulated agent
> memory. It does not itself ship a reader, writer, MCP server, or runner
> injection; those are separate, tracked roadmap items (see
> [Relationship to the rest of Memory v0](#relationship-to-the-rest-of-memory-v0)
> below). Publishing the format ahead of the store is deliberate: the format is
> the thing users need to trust *before* they pour knowledge into it.

## Why this exists

[docs/positioning.md](positioning.md) §3 lays out the thesis: Skynet's moat is
the accumulated, cross-vendor memory built from every agent's work — not the
agents themselves. But a moat only forms if users trust the accumulation, and
trust requires the opposite of lock-in: **memory that lives in the user's own
git repo, in plain text, readable and editable with no Skynet installed.**

- **Human-readable** — Markdown, not a binary blob or an opaque DB row. Anyone
  can open a memory file and understand it; no export step is needed because
  there's nothing to export *from*.
- **Git-committable** — memory lives in the repo it's about, versioned and
  blamed the same way code is. Diffing memory is as natural as diffing code.
  Cloning the repo clones the memory.
- **Versioned** — the format itself carries a version, so old files stay
  readable as the spec grows and tools can declare what they support.
- **A substrate, not a silo** — this format doesn't replace `AGENTS.md`,
  `CLAUDE.md`, `.cursor/rules`, or Copilot instructions. It sits alongside
  them as the durable, structured layer those simpler prose files get
  generated from (see below).

## Design goals

1. **Readable without tooling.** A person (or any LLM) can `cat` a memory file
   and understand every fact in it — no decoder required.
2. **Diffable and mergeable with plain `git diff` / `git merge`.** Facts are
   appended, not rewritten in place, so history stays meaningful and merge
   conflicts stay rare.
3. **Minimally structured.** Just enough machine-parseable metadata (scope,
   provenance, timestamps) to support filtering, dedup, and future
   distillation — everything else stays prose.
4. **Hand-editable.** A human can add, edit, or delete a fact directly with no
   loss of validity. Tools that write to these files must round-trip content
   they don't understand (unknown frontmatter keys, unknown fact metadata,
   prose the tool didn't itself add).
5. **Scoped, not flat.** Facts apply at a workspace, project, area, or
   agent-family level — matching how Skynet already scopes work — so
   injection can pull exactly the facts relevant to the task at hand.

## Layout on disk

Memory lives under `.skynet/memory/` at the repo root — next to
`.skynet/modules.json` (Skynet's existing derived-intelligence convention),
not inside it, since memory is authored/durable where the module map is
derived/disposable:

```
.skynet/
  memory/
    MEMORY.md                     # index: one line per fact file, human-curated
    workspace.md                  # facts scoped to the whole workspace
    projects/
      <project-slug>.md           # facts scoped to one project
    areas/
      <project-slug>/
        <area-slug>.md            # facts scoped to one area within a project
    agents/
      <family-slug>.md            # facts scoped to one agent family (claude, codex, ...)
```

`MEMORY.md` is a plain index — one line per file, e.g.
`- [Billing area](areas/acme-web/billing.md) — payment provider quirks and review preferences`
— kept short so it stays cheap to load as an overview before pulling a
specific file's full content.

Only create the directories a workspace actually uses. A repo with one
project and no area/agent-family memory yet is just
`.skynet/memory/{MEMORY.md,workspace.md,projects/<slug>.md}`.

## File anatomy

Every memory file is Markdown with YAML frontmatter for file-level metadata,
followed by one `##` section per fact.

### File-level frontmatter

```yaml
---
skynet_memory_version: 0.1
scope: project              # workspace | project | area | agent
project: acme-web           # present when scope is project or area
area: billing                # present when scope is area
agent_family: claude         # present when scope is agent
---
```

### Fact blocks

Each fact is a `##` heading (the fact itself, in plain language) followed by
an HTML-comment metadata line and an optional prose body. The comment is
inert to any Markdown renderer and to any LLM reading the file as
prose — it exists purely for tools that want to filter, dedupe, or supersede
facts programmatically.

```markdown
## Prefer snake_case for Python files
<!-- skynet:fact id=01J6ZQMFH2K9V4X3 source=operator author=jordan created=2026-08-12T14:03:00Z confidence=stated -->

Stated directly by an operator approving a diff gate in the HITL Inbox.
```

```markdown
## Review changes touching the billing webhook route closely
<!-- skynet:fact id=01J6ZRA1P7WYB0FQ source=decision run=run_9f2 hitl=q42 author=jordan created=2026-07-30T09:12:00Z confidence=derived -->

Derived from an `approve` decision whose guidance said a June regression
silently broke the billing webhook — the operator wants closer review of
that area going forward.
```

#### Fact metadata fields

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable identifier (ULID recommended). Used to supersede or dedupe a fact; never reused. |
| `source` | yes | Where the fact came from: `operator` (stated directly), `decision` (derived from a HITL resolution), or `distilled` (LLM-derived from history — not yet implemented anywhere in Skynet). |
| `author` | yes | Operator id, or agent id if agent-authored. |
| `created` | yes | ISO-8601 timestamp. |
| `confidence` | yes | `stated` (a human said this explicitly), `derived` (inferred from a decision), or `distilled` (LLM-inferred from broader history). |
| `run` | no | The run id this fact was captured during, if any. |
| `hitl` | no | The HITL item id this fact was captured from, if any. |
| `supersedes` | no | The `id` of a fact this one replaces. |

Unknown metadata keys and unknown frontmatter keys **must** be preserved by
any tool that rewrites a file — a reader from an older or unrelated tool
should never silently drop fields it doesn't recognize.

### Editing model: append, don't mutate

Facts are added by appending a new `##` section. Correcting or retiring a
fact is done by appending a new fact with `supersedes: <old id>` rather than
editing the old block in place — this keeps `git log` / `git blame` on the
file a meaningful record of *when the operator's understanding changed*,
mirroring how Skynet's own `hitl_audit` trail is append-only. A superseded
fact is left in the file (struck through or noted as superseded) rather than
deleted, so history isn't lost; a reader building a "current facts" view
filters out anything superseded.

Hand-written facts are first-class: a human adding a `##` section directly,
with `source: operator` and no `run`/`hitl` fields, is exactly as valid as
one captured through the product.

## Versioning

`skynet_memory_version` is the format version, tracked independently of
Skynet's own product version (semver-ish, currently `0.1` — pre-1.0, additive
changes only expected). Compatibility rules:

- A reader **must** tolerate unknown frontmatter keys, unknown fact metadata
  keys, and unrecognized `source`/`confidence` values (treat as opaque,
  don't error).
- A writer **must not** drop content it doesn't understand when it rewrites a
  file — only ever append.
- A breaking change (removing a required field, changing a field's meaning)
  bumps the major-equivalent version and is called out in the changelog below.

### Spec changelog

- **0.1** (2026-08-26) — initial draft: file layout, frontmatter, fact block
  schema, append-only editing model.

## Relationship to the rest of Memory v0

This document specifies the file format only. It deliberately does not cover
(tracked separately in [ROADMAP.md](../ROADMAP.md) under "v4 — Moat Layer:
Portable cross-vendor memory"):

- **Where facts come from** — today `Resolution.memoryNote` (the "+ Also
  remember" toggle on a HITL approval) and `hitl_audit` already capture
  operator intent and decisions, but nothing reads them back yet; a store
  that writes them into this format is future work.
- **Injection into a running agent** via the `runner-sdk` seam.
- **Memory as an MCP server** so any tool, even outside Skynet, can read or
  write these files.
- **Translating to/from vendor-native files** (`AGENTS.md`, `CLAUDE.md`,
  `.cursor/rules`, Copilot instructions) — this format is meant to be the
  structured source those simpler prose files can be generated from, but that
  generation/sync is separate, unbuilt work.
- **LLM-assisted distillation** of good memory from raw history.

Publishing the format now, ahead of all of the above, is the point: it's the
contract users can hold Skynet to as the rest of Memory v0 gets built.
