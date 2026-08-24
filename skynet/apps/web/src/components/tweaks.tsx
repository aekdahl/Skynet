import { useEffect, useState, type ReactNode } from "react";

// A lightweight tweaks model. The prototype persisted via a host postMessage
// protocol; here the values just live in React state and drive --accent /
// data-density on the app root.

export interface Tweaks {
  accent: string;
  density: "compact" | "regular" | "comfy";
}

export const TWEAK_DEFAULTS: Tweaks = {
  accent: "#FFB224",
  density: "regular",
};

export function useTweaks(): [Tweaks, <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void] {
  const [values, setValues] = useState<Tweaks>(TWEAK_DEFAULTS);
  const setTweak = <K extends keyof Tweaks>(k: K, v: Tweaks[K]) =>
    setValues((prev) => ({ ...prev, [k]: v }));
  return [values, setTweak];
}

const PANEL_STYLE: React.CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 40,
  zIndex: 2147483646,
  width: 240,
  background: "var(--panel)",
  color: "var(--text)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "0 12px 40px rgba(0,0,0,.4)",
  fontFamily: "var(--font-ui)",
  fontSize: 12,
  overflow: "hidden",
};

export function TweaksPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        title="Tweaks (⌘.)"
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "fixed",
          right: 16,
          bottom: 40,
          zIndex: 2147483645,
          width: 34,
          height: 34,
          borderRadius: 8,
          border: "1px solid var(--line)",
          background: "var(--raised)",
          color: "var(--muted)",
          cursor: "pointer",
          display: open ? "none" : "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ⚙
      </button>
      {open && (
        <div style={PANEL_STYLE}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <b>Tweaks</b>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close Tweaks panel"
              style={{
                background: "none",
                border: "none",
                color: "var(--faint)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              ✕
            </button>
          </div>
          <div
            style={{
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {children}
          </div>
        </div>
      )}
    </>
  );
}

export function TweakSection({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--muted)",
      }}
    >
      {label}
    </div>
  );
}

export function TweakColor({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {options.map((c) => (
          <button
            key={c}
            onClick={() => onChange(c)}
            aria-label={c}
            style={{
              width: 40,
              height: 26,
              borderRadius: 6,
              background: c,
              cursor: "pointer",
              border:
                value.toLowerCase() === c.toLowerCase()
                  ? "2px solid var(--text)"
                  : "1px solid var(--line)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function TweakRadio<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <div
        style={{
          display: "flex",
          gap: 2,
          background: "var(--raised)",
          borderRadius: 8,
          padding: 2,
        }}
      >
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            style={{
              flex: 1,
              border: "none",
              borderRadius: 6,
              padding: "6px 4px",
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              background: value === o ? "var(--line)" : "transparent",
              color: value === o ? "var(--text)" : "var(--muted)",
            }}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TweakToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        style={{
          width: 34,
          height: 19,
          borderRadius: 12,
          border: "none",
          cursor: "pointer",
          position: "relative",
          background: value ? "var(--ok)" : "var(--line)",
        }}
      >
        <i
          style={{
            position: "absolute",
            top: 2,
            left: value ? 17 : 2,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s",
          }}
        />
      </button>
    </div>
  );
}
