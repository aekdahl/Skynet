import { Fragment, useState, type ReactNode } from "react";

// A tiny, dependency-free markdown renderer covering exactly what our docs use:
// #/##/###/#### headings, ---, ordered/unordered lists nested to ANY depth, bold,
// italic, inline code, links, and GitHub-style status checkboxes ([x] done, [~]
// in progress, [ ] planned) on list items. Repo-relative links resolve to GitHub
// so [docs/positioning.md](docs/positioning.md) works from inside the app.

const LINK_BASE = "https://github.com/aekdahl/Skynet/blob/main/skynet/";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // code · bold · italic · link — first match wins, then recurse on the rest.
  const re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/;
  let rest = text;
  let i = 0;
  while (rest) {
    const m = re.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3]) out.push(<strong key={k}>{inline(m[4]!, k)}</strong>);
    else if (m[5]) out.push(<em key={k}>{inline(m[6]!, k)}</em>);
    else if (m[7]) {
      const href = /^https?:\/\//.test(m[9]!) ? m[9]! : LINK_BASE + m[9]!.replace(/^\.\//, "");
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer">
          {m[8]}
        </a>,
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// A GitHub-style task checkbox at the start of a list item → a status. `[x]` done,
// `[~]` in progress, `[ ]` planned; anything else → no status.
export type Status = "done" | "wip" | "todo" | null;
export function parseStatus(text: string): { status: Status; rest: string } {
  const m = text.match(/^\[([ xX~])\]\s+(.*)$/);
  if (!m) return { status: null, rest: text };
  const c = m[1]!.toLowerCase();
  return { status: c === "x" ? "done" : c === "~" ? "wip" : "todo", rest: m[2]! };
}

export type ListItem = { text: string; status: Status; children: ListItem[] };
export type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "p"; text: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] };

// Indentation → nesting: an item indented deeper than the previous nests under it.
// A stack tracks open levels (each: its indent width + the item array to push into
// + the last item, which a deeper level nests beneath).
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: ListItem[] } | null = null;
  let stack: Array<{ indent: number; items: ListItem[]; last: ListItem | null }> = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
    stack = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
    const cont = line.match(/^(\s+)(\S.*)/); // wrapped continuation of a list item

    if (h) {
      flushPara();
      flushList();
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]! });
    } else if (/^---+$/.test(line)) {
      flushPara();
      flushList();
      blocks.push({ kind: "hr" });
    } else if (li) {
      flushPara();
      const indent = li[1]!.length;
      const ordered = /^\d+\.$/.test(li[2]!);
      const { status, rest } = parseStatus(li[3]!);
      const item: ListItem = { text: rest, status, children: [] };
      if (!list) {
        list = { ordered, items: [] };
        stack = [{ indent, items: list.items, last: null }];
      }
      // Pop deeper levels until the top is at-or-shallower than this item.
      while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
      const top = stack[stack.length - 1]!;
      if (indent > top.indent && top.last) {
        // Deeper than the current level → open a nested list under its last item.
        stack.push({ indent, items: top.last.children, last: null });
      }
      const cur = stack[stack.length - 1]!;
      cur.items.push(item);
      cur.last = item;
    } else if (cont && list && stack.length) {
      // A wrapped line continues the most-recent item at the current level.
      const cur = stack[stack.length - 1]!;
      if (cur.last) cur.last.text += " " + cont[2]!;
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

function StatusPill({ status }: { status: Status }) {
  if (!status) return null;
  const meta =
    status === "done"
      ? { cls: "md-st-done", mark: "✓", label: "shipped" }
      : status === "wip"
        ? { cls: "md-st-wip", mark: "◐", label: "in progress" }
        : { cls: "md-st-todo", mark: "○", label: "planned" };
  return (
    <span className={"md-status " + meta.cls} title={meta.label}>
      <span className="md-status-mark">{meta.mark}</span>
      {meta.label}
    </span>
  );
}

function List({ ordered, items, keyBase }: { ordered: boolean; items: ListItem[]; keyBase: string }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag>
      {items.map((it, j) => {
        const k = `${keyBase}-${j}`;
        return (
          <li key={k} className={it.status ? "md-li-status md-li-" + it.status : undefined}>
            <span className="md-li-body">
              <StatusPill status={it.status} />
              <span>{inline(it.text, k)}</span>
            </span>
            {it.children.length > 0 && <List ordered={false} items={it.children} keyBase={k} />}
          </li>
        );
      })}
    </Tag>
  );
}

// Render a flat list of blocks — the shared body used by both the plain and the
// folded paths. `keyBase` namespaces React keys so sections never collide.
function renderBlocks(blocks: Block[], keyBase: string): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${keyBase}-${i}`;
    if (b.kind === "hr") return <hr key={key} />;
    if (b.kind === "h") {
      const Tag = (["h1", "h2", "h3", "h4"] as const)[b.level - 1] ?? "h4";
      return <Tag key={key}>{inline(b.text, `h${key}`)}</Tag>;
    }
    if (b.kind === "list") return <List key={key} ordered={b.ordered} items={b.items} keyBase={"l" + key} />;
    return <Fragment key={key}>{b.text ? <p>{inline(b.text, `p${key}`)}</p> : null}</Fragment>;
  });
}

// A heading is "shipped" when it carries the ✓ shipped marker.
export function headingIsShipped(text: string): boolean {
  return /✓\s*shipped/i.test(text);
}

// Group a flat block list by level-2 (`##`) headings. Blocks before the first `##`
// are the `lead`; each `##` opens a section whose `body` runs until the next `##`.
export function sectionsFromBlocks(blocks: Block[]): {
  lead: Block[];
  sections: { heading: string; body: Block[] }[];
} {
  const lead: Block[] = [];
  const sections: { heading: string; body: Block[] }[] = [];
  let cur: { heading: string; body: Block[] } | null = null;
  for (const b of blocks) {
    if (b.kind === "h" && b.level === 2) {
      cur = { heading: b.text, body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(b);
    } else {
      lead.push(b);
    }
  }
  return { lead, sections };
}

// Count status-bearing list items (done vs. total) anywhere in a section's body.
function countStatuses(blocks: Block[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (items: ListItem[]) => {
    for (const it of items) {
      if (it.status) {
        total++;
        if (it.status === "done") done++;
      }
      if (it.children.length) walk(it.children);
    }
  };
  for (const b of blocks) if (b.kind === "list") walk(b.items);
  return { done, total };
}

function FoldSection({ heading, body, sIdx }: { heading: string; body: Block[]; sIdx: number }) {
  const [open, setOpen] = useState(false);
  const title = heading.replace(/✓\s*shipped/i, "").trim();
  const { done, total } = countStatuses(body);
  return (
    <div className="md-fold">
      <button
        type="button"
        className="md-fold-summary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="md-fold-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="md-status md-st-done">
          <span className="md-status-mark">✓</span>shipped
        </span>
        <span className="md-fold-title">{inline(title, `fold-h-${sIdx}`)}</span>
        {total > 0 && (
          <span className="md-fold-count">
            {done}/{total}
          </span>
        )}
      </button>
      {open && <div className="md-fold-body">{renderBlocks(body, `fold-b-${sIdx}`)}</div>}
    </div>
  );
}

export function Markdown({ text, foldShipped = false }: { text: string; foldShipped?: boolean }) {
  const blocks = parseMarkdown(text);
  if (!foldShipped) {
    return <div className="md">{renderBlocks(blocks, "b")}</div>;
  }
  const { lead, sections } = sectionsFromBlocks(blocks);
  return (
    <div className="md">
      {renderBlocks(lead, "lead")}
      {sections.map((s, i) =>
        headingIsShipped(s.heading) ? (
          <FoldSection key={`s${i}`} heading={s.heading} body={s.body} sIdx={i} />
        ) : (
          <Fragment key={`s${i}`}>
            <h2>{inline(s.heading, `sh${i}`)}</h2>
            {renderBlocks(s.body, `sb${i}`)}
          </Fragment>
        ),
      )}
    </div>
  );
}
