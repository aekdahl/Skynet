// Agent chats now live in the dock alongside Steward, so a conversation follows
// the operator around instead of dying when they browse away. Losing a
// half-typed reply because you clicked through to check the thing the agent
// just asked about is enough of a tax that people stop asking agents things —
// the opposite of what the chat is for.
//
// Source-scanning, because the properties that matter here are structural and
// nothing type-checks them: state ABOVE the dock, panes hidden rather than
// unmounted, and the close affordance not doubling as select.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = () => read("../apps/web/src/App.tsx");
const dock = () => read("../apps/web/src/components/steward-dock.tsx");
const chat = () => read("../apps/web/src/components/agent-chat.tsx");

describe("the tabs survive navigation", () => {
  it("keeps open-tab state ABOVE the dock, in App", () => {
    // If this lived inside the dock it would still survive (the dock is mounted
    // once), but the moment anything conditionally renders the dock the tabs
    // vanish. App owns it because App outlives every view.
    expect(app()).toContain("const [agentTabs, setAgentTabs]");
    expect(app()).toContain("const [dockTab, setDockTab]");
  });

  it("hides inactive panes rather than unmounting them", () => {
    // A chat's thread and half-typed input are component state. Unmounting on
    // tab switch throws both away — the exact loss this feature prevents.
    expect(dock()).toContain('"dock-pane" + (active === "steward" ? "" : " hidden")');
    expect(dock()).toContain('"dock-pane" + (active === runId ? "" : " hidden")');
    const css = read("../apps/web/src/styles.css");
    expect(css).toContain(".dock-pane.hidden { display: none; }");
  });

  it("opens a chat from anywhere via an event, not a threaded callback", () => {
    expect(app()).toContain('window.addEventListener("skynet:open-agent-chat"');
    expect(read("../apps/web/src/views/task.tsx")).toContain('new CustomEvent("skynet:open-agent-chat"');
  });
});

describe("closing a tab", () => {
  it("stops the click from also selecting the tab it just closed", () => {
    // The ✕ is inside the tab button; without stopPropagation, closing would
    // also activate it — selecting a pane that is being removed.
    expect(dock()).toContain("e.stopPropagation()");
  });

  it("lands somewhere real when you close the tab you're viewing", () => {
    expect(app()).toContain('setDockTab((cur) => (cur === runId ? "steward" : cur))');
  });

  it("has no close button on the Steward tab — it IS the dock", () => {
    const stewardTab = dock().slice(dock().indexOf('onClick={() => onActivateTab("steward")}'));
    expect(stewardTab.slice(0, 200)).not.toContain("dock-tab-x");
  });
});

describe("a blocked agent stays visible from wherever you are", () => {
  it("marks a tab whose run is waiting on a human", () => {
    expect(dock()).toContain("runNeedsYou");
    expect(dock()).toContain("needsyou");
  });

  it("counts an unresolved gate, not just the run's own status", () => {
    // A run can be mid-turn while a gate it raised is still open; either one
    // means the agent is stuck on you.
    expect(chat()).toContain('run.status === "waiting"');
    expect(chat()).toContain("queueRunIds.has(run.id)");
  });

  it("does NOT duplicate the approve/reject controls into the dock", () => {
    // Two places rendering the same decision is two places to keep correct.
    // The dock says "go answer it"; the run page and Inbox own the answering.
    expect(chat()).not.toContain("resolveHitl");
    expect(chat()).toContain("open the run or the Inbox");
  });
});

describe("the dock shows the conversation, not the whole run log", () => {
  it("filters telemetry out — tool lines are why the run page exists", () => {
    expect(chat()).toContain('line.startsWith("you: ")');
    expect(chat()).toContain('line.startsWith("↳ ")');
  });
});
