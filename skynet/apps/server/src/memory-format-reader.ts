// ─── Skynet Open Memory Format — reader (v4 slice) ──────────────────────────
// Parses the git-committable `.skynet/memory/` layout defined in
// docs/memory-format.md (file-level YAML frontmatter + append-only `##` fact
// blocks) into structured data. Read-only: no writer, no MCP surface, no
// runner injection — those are separate, tracked roadmap items.
//
// Per the spec's compatibility rules, this reader tolerates unknown
// frontmatter keys, unknown fact metadata keys, and unrecognized
// `source`/`confidence` values — it never errors on them, it carries them
// through as opaque `extra` fields.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const KNOWN_FACT_KEYS = new Set(["id", "source", "author", "created", "confidence", "run", "hitl", "supersedes"]);

export interface MemoryFact {
  /** Fact text — the `##` heading, verbatim. */
  heading: string;
  /** Optional prose body between the metadata comment and the next fact. */
  body: string;
  id: string;
  source: string;
  author: string;
  created: string;
  confidence: string;
  run?: string;
  hitl?: string;
  supersedes?: string;
  /** Unknown `skynet:fact` metadata keys, preserved verbatim. */
  extra: Record<string, string>;
}

export interface MemoryFileFrontmatter {
  skynet_memory_version?: string;
  scope?: string;
  project?: string;
  area?: string;
  agent_family?: string;
  /** Unknown frontmatter keys, preserved verbatim. */
  extra: Record<string, string>;
}

export interface MemoryFile {
  /** Path relative to `.skynet/memory/`, e.g. `projects/acme-web.md`. */
  path: string;
  frontmatter: MemoryFileFrontmatter;
  facts: MemoryFact[];
}

function parseFrontmatter(text: string): { frontmatter: MemoryFileFrontmatter; rest: string } {
  const frontmatter: MemoryFileFrontmatter = { extra: {} };
  if (!text.startsWith("---")) return { frontmatter, rest: text };

  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1) return { frontmatter, rest: text };
  const end = text.indexOf("\n---", firstBreak);
  if (end === -1) return { frontmatter, rest: text };

  const block = text.slice(firstBreak + 1, end);
  const afterMarker = text.indexOf("\n", end + 1);
  const rest = afterMarker === -1 ? "" : text.slice(afterMarker + 1);

  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    if (key === undefined) continue;
    const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    switch (key) {
      case "skynet_memory_version":
      case "scope":
      case "project":
      case "area":
      case "agent_family":
        frontmatter[key] = value;
        break;
      default:
        frontmatter.extra[key] = value;
    }
  }
  return { frontmatter, rest };
}

function parseFactMetadata(comment: string): Pick<MemoryFact, "id" | "source" | "author" | "created" | "confidence" | "run" | "hitl" | "supersedes" | "extra"> {
  const extra: Record<string, string> = {};
  const fact: Record<string, string> = {};
  const re = /([A-Za-z0-9_-]+)=("[^"]*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(comment))) {
    const key = m[1];
    if (key === undefined) continue;
    const value = (m[2] ?? "").replace(/^"|"$/g, "");
    if (KNOWN_FACT_KEYS.has(key)) fact[key] = value;
    else extra[key] = value;
  }
  return {
    id: fact.id ?? "",
    source: fact.source ?? "",
    author: fact.author ?? "",
    created: fact.created ?? "",
    confidence: fact.confidence ?? "",
    run: fact.run,
    hitl: fact.hitl,
    supersedes: fact.supersedes,
    extra,
  };
}

function parseFacts(body: string): MemoryFact[] {
  const facts: MemoryFact[] = [];
  const headingRe = /^##[ \t]+(.+)$/gm;
  const headings: { heading: string; start: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body))) {
    headings.push({ heading: (m[1] ?? "").trim(), start: m.index, contentStart: m.index + m[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    if (!current) continue;
    const { heading, contentStart } = current;
    const next = headings[i + 1];
    const end = next ? next.start : body.length;
    const block = body.slice(contentStart, end);

    const commentMatch = /<!--\s*skynet:fact([^]*?)-->/.exec(block);
    if (!commentMatch) {
      facts.push({ heading, body: block.trim(), id: "", source: "", author: "", created: "", confidence: "", extra: {} });
      continue;
    }
    const metadata = parseFactMetadata(commentMatch[1] ?? "");
    const restBody = block.slice(commentMatch.index + commentMatch[0].length).trim();
    facts.push({ heading, body: restBody, ...metadata });
  }
  return facts;
}

/** Parse a single memory file's raw text (pure, no filesystem access). */
export function parseMemoryFile(content: string, path = ""): MemoryFile {
  const { frontmatter, rest } = parseFrontmatter(content);
  return { path, frontmatter, facts: parseFacts(rest) };
}

/** Read and parse one memory file from disk. Returns `null` if it doesn't exist. */
export async function readMemoryFile(absPath: string, relPath = ""): Promise<MemoryFile | null> {
  const content = await readFile(absPath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (content == null) return null;
  return parseMemoryFile(content, relPath || absPath);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
}

/**
 * Read every fact file under `<repoPath>/.skynet/memory/` (workspace.md,
 * projects/*.md, areas/<project>/*.md, agents/*.md) per the layout in
 * docs/memory-format.md. `MEMORY.md` itself is the human-curated index, not a
 * fact file, and is intentionally excluded. Missing directories are treated
 * as "this workspace doesn't use that scope yet", not an error.
 */
export async function readWorkspaceMemory(repoPath: string): Promise<MemoryFile[]> {
  const base = join(repoPath, ".skynet", "memory");
  const files: MemoryFile[] = [];

  const workspace = await readMemoryFile(join(base, "workspace.md"), "workspace.md");
  if (workspace) files.push(workspace);

  for (const name of await listMarkdownFiles(join(base, "projects"))) {
    const relPath = join("projects", name);
    const file = await readMemoryFile(join(base, relPath), relPath);
    if (file) files.push(file);
  }

  for (const name of await listMarkdownFiles(join(base, "agents"))) {
    const relPath = join("agents", name);
    const file = await readMemoryFile(join(base, relPath), relPath);
    if (file) files.push(file);
  }

  const areaProjectDirs = await readdir(join(base, "areas"), { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    },
  );
  for (const projectDir of areaProjectDirs) {
    if (!projectDir.isDirectory()) continue;
    for (const name of await listMarkdownFiles(join(base, "areas", projectDir.name))) {
      const relPath = join("areas", projectDir.name, name);
      const file = await readMemoryFile(join(base, relPath), relPath);
      if (file) files.push(file);
    }
  }

  return files;
}

/**
 * Facts still in effect: drops any fact referenced by another fact's
 * `supersedes` field. Per the spec's append-only editing model, a superseded
 * fact stays in the file as history but shouldn't feed a "what's true now"
 * view.
 */
export function currentFacts(facts: MemoryFact[]): MemoryFact[] {
  const superseded = new Set(facts.map((f) => f.supersedes).filter((id): id is string => Boolean(id)));
  return facts.filter((f) => !superseded.has(f.id));
}
