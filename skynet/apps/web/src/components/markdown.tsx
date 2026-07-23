import { Fragment, type ReactNode } from "react";

// A tiny, dependency-free markdown renderer covering exactly what our docs use:
// #/##/### headings, ---, ordered/unordered lists (one nesting level), bold,
// italic, inline code, and links. Repo-relative links resolve to GitHub so
// [docs/positioning.md](docs/positioning.md) works from inside the app.

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

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "p"; text: string }
  | { kind: "list"; ordered: boolean; items: Array<{ text: string; sub: string[] }> };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: Array<{ text: string; sub: string[] }> } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^([-*]|\d+\.)\s+(.*)/);
    const sub = line.match(/^\s{2,}([-*]|\d+\.)\s+(.*)/);
    const cont = line.match(/^\s{2,}(\S.*)/); // wrapped continuation of a list item
    if (h) {
      flushPara(); flushList();
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]! });
    } else if (/^---+$/.test(line)) {
      flushPara(); flushList();
      blocks.push({ kind: "hr" });
    } else if (li) {
      flushPara();
      const ordered = /^\d+\.$/.test(li[1]!);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push({ text: li[2]!, sub: [] });
    } else if (sub && list?.items.length) {
      list.items[list.items.length - 1]!.sub.push(sub[2]!);
    } else if (cont && list?.items.length) {
      const last = list.items[list.items.length - 1]!;
      if (last.sub.length) last.sub[last.sub.length - 1] += " " + cont[1]!;
      else last.text += " " + cont[1]!;
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.kind === "hr") return <hr key={i} />;
        if (b.kind === "h") {
          const Tag = (["h1", "h2", "h3"] as const)[b.level - 1]!;
          return <Tag key={i}>{inline(b.text, `h${i}`)}</Tag>;
        }
        if (b.kind === "list") {
          const Tag = b.ordered ? "ol" : "ul";
          return (
            <Tag key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  {inline(it.text, `l${i}-${j}`)}
                  {it.sub.length > 0 && (
                    <ul>
                      {it.sub.map((s, k) => (
                        <li key={k}>{inline(s, `s${i}-${j}-${k}`)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </Tag>
          );
        }
        return <Fragment key={i}>{b.text ? <p>{inline(b.text, `p${i}`)}</p> : null}</Fragment>;
      })}
    </div>
  );
}
