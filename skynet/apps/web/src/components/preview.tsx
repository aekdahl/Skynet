import type { Agent, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import { agentsForProject, heartbeatSecs, planDone } from "../lib/derive";

// Live previews: the artifact each agent is building. The prototype keyed these
// off fixed demo ids; here we render a faithful generic surface (terminal for
// non-visual work, a rendered app frame for visual deliverables) sourced from
// store data, with freshness derived from the live heartbeat.

function PvShell({
  label,
  fresh,
  tone,
  children,
}: {
  label: string;
  fresh: string;
  tone?: "light";
  children: React.ReactNode;
}) {
  return (
    <div className="pv">
      <div className="pv-bar">
        <span className="pv-label mono">{label}</span>
        <span className="pv-fresh">
          <span className="pv-live" />
          live · {fresh}
        </span>
      </div>
      <div className={"pv-body" + (tone === "light" ? " pv-light" : "")}>
        {children}
      </div>
    </div>
  );
}

function PvTerm({ lines }: { lines: string[] }) {
  return (
    <div className="pv-term">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            "pv-tline" +
            (l.startsWith("✓") ? " pv-ok" : l.startsWith("▸") ? " pv-act" : "")
          }
        >
          {l}
        </div>
      ))}
      <div className="pv-tline pv-cursor">▌</div>
    </div>
  );
}

export function PreviewFor({ agent }: { agent: Agent }) {
  const now = agent.plan.find((p) => p.state === "now");
  const done = planDone(agent);

  if (agent.visual) {
    return (
      <PvShell label={agent.name + " · live UI"} fresh="just now" tone="light">
        <div className="dlv-app">
          <div className="dlv-appbar">
            <span className="dlv-dotrow">
              <i />
              <i />
              <i />
            </span>
            <span className="dlv-url">app.cyberdyne.net/{agent.branch.split("/").pop()}</span>
          </div>
          <div className="dlv-pad dlv-center">
            <div className="dlv-buildspin" />
            <div className="dlv-h1">{agent.name}</div>
            <div className="dlv-sub">
              {agent.status === "done"
                ? "shipped"
                : "Building: " + (now ? now.text : "wrap-up")}
            </div>
          </div>
        </div>
      </PvShell>
    );
  }

  return (
    <PvShell label={agent.name} fresh="just now">
      <PvTerm
        lines={[
          '$ skynet run "' + agent.name + '"',
          "✓ workspace ready on " + (agent.branch || "agent branch"),
          done > 0
            ? "✓ " + done + " step" + (done > 1 ? "s" : "") + " complete"
            : "▸ planning approach",
          "▸ " + (now ? now.text : "working…"),
        ]}
      />
    </PvShell>
  );
}

// ─── project-level delivery preview ─────────────────────────────────────────

export function visualLeadOf(project: Project, agents: Agent[]): Agent | null {
  const pa = agentsForProject(agents, project.id).filter((a) => a.visual);
  const live = pa
    .filter((a) => a.status !== "done")
    .sort((x, y) => y.progress - x.progress);
  return live[0] ?? pa.find((a) => a.status === "done") ?? null;
}

export function ProjectDelivery({ project }: { project: Project }) {
  const { agents } = useStore();
  const now = Date.now();
  const lead = visualLeadOf(project, agents);
  if (!lead) return null;

  const fresh = (() => {
    const pa = agentsForProject(agents, project.id).filter(
      (a) => a.status !== "done",
    );
    if (!pa.length) return "just now";
    const hb = Math.floor(Math.min(...pa.map((a) => heartbeatSecs(a, now))));
    return hb < 60 ? hb + "s ago" : Math.round(hb / 60) + "m ago";
  })();

  return (
    <PvShell label={project.name + " · preview"} fresh={fresh} tone="light">
      <div className="dlv-app">
        <div className="dlv-appbar">
          <span className="dlv-dotrow">
            <i />
            <i />
            <i />
          </span>
          <span className="dlv-url">app.cyberdyne.net/{project.id}</span>
        </div>
        <div className="dlv-pad dlv-center">
          <div className="dlv-buildspin" />
          <div className="dlv-h1">{project.name}</div>
          <div className="dlv-sub">
            {lead.status === "done"
              ? "Shipped: " + lead.name
              : "Building: " + lead.name}
          </div>
        </div>
      </div>
    </PvShell>
  );
}
