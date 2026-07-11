import type { ReactNode } from "react";
import type { TaskRunStatus, ProviderInfo } from "@skynet/shared";

export function StatusDot({ status }: { status: TaskRunStatus }) {
  return <span className={"dot dot-" + status} />;
}

// A loud, consistent marker for any placeholder / demo / not-yet-wired UI, so
// temporary data is never mistaken for the real thing. Use it wherever the
// content shown is mock or a stand-in for an unbuilt backend flow.
export function PlaceholderNote({ children }: { children: ReactNode }) {
  return (
    <div className="placeholder-note" role="note">
      <span className="placeholder-note-tag">PLACEHOLDER</span>
      <span className="placeholder-note-text">{children}</span>
    </div>
  );
}

export function Bar({ value, status }: { value: number; status: TaskRunStatus }) {
  return (
    <div className="bar">
      <div
        className={"bar-fill bar-" + status}
        style={{ width: Math.round(value * 100) + "%" }}
      />
    </div>
  );
}

export function Prov({ info }: { info: ProviderInfo }) {
  return (
    <span className="prov" style={{ color: info.color }} title={info.name}>
      {info.glyph}
    </span>
  );
}
