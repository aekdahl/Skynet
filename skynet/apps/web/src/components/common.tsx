import type { AgentStatus, ProviderInfo } from "@skynet/shared";

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={"dot dot-" + status} />;
}

export function Bar({ value, status }: { value: number; status: AgentStatus }) {
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
