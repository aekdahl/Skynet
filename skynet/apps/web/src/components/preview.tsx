import type { TaskRun, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import { agentsForProject, fmtWait, heartbeatSecs } from "../lib/derive";

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

// The real, sandboxed preview the backend reserved for this branch (W5). No
// `allow-same-origin`: this URL defaults to Skynet's OWN origin
// (SKYNET_PREVIEW_BASE_URL is opt-in — see preview/config.ts), and that flag
// combined with allow-scripts would let previewed (agent-built, possibly
// prompt-injected) app code read this origin's storage — including the
// session token — for a full session hijack. Dropping it forces the framed
// document into an opaque origin regardless of the URL it's served from, so
// the previewed app still runs, it just can't touch this origin's storage.
function PreviewFrame({ url, title }: { url: string; title: string }) {
  return (
    <iframe
      title={title}
      src={url}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      referrerPolicy="no-referrer"
      loading="lazy"
      style={{ display: "block", width: "100%", height: 300, border: 0, background: "#fff" }}
    />
  );
}

const hostPath = (url: string) => url.replace(/^https?:\/\//, "");

// ─── project-level delivery preview ─────────────────────────────────────────

export function visualLeadOf(project: Project, runs: TaskRun[]): TaskRun | null {
  const pa = agentsForProject(runs, project.id).filter((a) => a.visual);
  const live = pa
    .filter((a) => a.status !== "done")
    .sort((x, y) => y.progress - x.progress);
  return live[0] ?? pa.find((a) => a.status === "done") ?? null;
}

export function ProjectDelivery({ project }: { project: Project }) {
  const { runs } = useStore();
  const now = Date.now();
  const lead = visualLeadOf(project, runs);
  if (!lead) return null;

  const fresh = (() => {
    const pa = agentsForProject(runs, project.id).filter(
      (a) => a.status !== "done",
    );
    if (!pa.length) return "just now";
    const hb = Math.min(...pa.map((a) => heartbeatSecs(a, now)));
    return fmtWait(hb) + " ago";
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
