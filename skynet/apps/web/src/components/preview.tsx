import type { Agent, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import { agentsForProject, heartbeatSecs } from "../lib/derive";

// Live previews: the artifact each agent is building. The prototype keyed these
// off fixed demo ids; here we render a faithful generic surface (terminal for
// non-visual work, a rendered app frame for visual deliverables) sourced from
// store data, with freshness derived from the live heartbeat.

function PvShell({
  label,
  fresh,
  tone,
  done,
  children,
}: {
  label: string;
  fresh: string;
  tone?: "light";
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="pv">
      <div className="pv-bar">
        <span className="pv-label mono">{label}</span>
        <span className="pv-fresh">
          <span className={"pv-live" + (done ? " pv-live-done" : "")} />
          {done ? "done" : "live · " + fresh}
        </span>
      </div>
      <div className={"pv-body" + (tone === "light" ? " pv-light" : "")}>
        {children}
      </div>
    </div>
  );
}

// The real, sandboxed preview the backend reserved for this branch (W5). The
// iframe is sandboxed so previewed app code can't reach the console origin;
// production should also serve previews from a separate origin (subdomain).
function PreviewFrame({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      title={title}
      src={url}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ display: "block", width: "100%", height: 300, border: 0, background: "#fff" }}
    />
  );
}

const hostPath = (url: string) => url.replace(/^https?:\/\//, "");

export function PreviewFor({ agent }: { agent: Agent }) {
  const now = agent.plan.find((p) => p.state === "now");

  if (agent.visual) {
    return (
      <PvShell label={agent.name + " · live UI"} fresh="just now" tone="light" done={agent.status === "done"}>
        <div className="dlv-app">
          <div className="dlv-appbar">
            <span className="dlv-dotrow">
              <i />
              <i />
              <i />
            </span>
            <span className="dlv-url">
              {agent.previewUrl ? hostPath(agent.previewUrl) : "app.cyberdyne.net/" + agent.branch.split("/").pop()}
            </span>
          </div>
          {agent.previewUrl ? (
            <PreviewFrame url={agent.previewUrl} title={agent.name + " preview"} />
          ) : (
            <div className="dlv-pad dlv-center">
              <div className="dlv-buildspin" />
              <div className="dlv-h1">{agent.name}</div>
              <div className="dlv-sub">
                {agent.status === "done"
                  ? "shipped"
                  : "Building: " + (now ? now.text : "wrap-up")}
              </div>
            </div>
          )}
        </div>
      </PvShell>
    );
  }

  // Non-visual agent: no renderable delivery. Don't fabricate a terminal — the
  // agent's real activity is in the LIVE LOG panel. Callers fold this panel away
  // for non-visual agents; this is the defensive fallback if one renders it.
  return (
    <PvShell label={agent.name} fresh="just now" done={agent.status === "done"}>
      <div className="pv-none">
        No live preview — this agent has no renderable delivery. Follow its work in the log.
      </div>
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
          <span className="dlv-url">
            {lead.previewUrl ? hostPath(lead.previewUrl) : "app.cyberdyne.net/" + project.id}
          </span>
        </div>
        {lead.previewUrl ? (
          <PreviewFrame url={lead.previewUrl} title={project.name + " preview"} />
        ) : (
          <div className="dlv-pad dlv-center">
            <div className="dlv-buildspin" />
            <div className="dlv-h1">{project.name}</div>
            <div className="dlv-sub">
              {lead.status === "done"
                ? "Shipped: " + lead.name
                : "Building: " + lead.name}
            </div>
          </div>
        )}
      </div>
    </PvShell>
  );
}
