// Tower — Operator variations: design-canvas with 5 takes on the three-pane console

function OpsApp() {
  return (
    <DesignCanvas>
      <DCSection id="o1" title="A · Classic" subtitle="The winning layout as-is: title bar with traffic lights, icon+label sidebar with a workspace switcher, grouped inbox list, card-based inspector, amber accent, comfortable density. The dependable default.">
        <DCArtboard id="classic" label="A — Classic" width={1440} height={900}><Operator /></DCArtboard>
      </DCSection>
      <DCSection id="o2" title="B · Rail / Pro" subtitle="Denser and keyboard-forward: a thin icon rail, a full-width command bar, grouped (Waiting / Review) list, and a two-column inspector with inline actions. Cool steel accent. For power operators running a big fleet.">
        <DCArtboard id="rail" label="B — Rail / Pro" width={1440} height={900}><OpRail /></DCArtboard>
      </DCSection>
      <DCSection id="o3" title="C · Focus" subtitle="Decision-first: minimal chrome, a slim vertical queue, and one large decision surface at a time. Big title, full context, big Approve/Reject. Built around 'clear one blocker, move to the next'.">
        <DCArtboard id="focus" label="C — Focus" width={1440} height={900}><OpFocus /></DCArtboard>
      </DCSection>
      <DCSection id="o4" title="D · Preview-forward" subtitle="The inspector leads with a large live preview of what's being built (rendered product for visual work, terminal for backend), context below. Warmer, larger type, per-module color. For teams who steer by seeing the work.">
        <DCArtboard id="preview" label="D — Preview-forward" width={1440} height={900}><OpPreview /></DCArtboard>
      </DCSection>
      <DCSection id="o5" title="E · Workbench" subtitle="The most IDE-like: a tabbed inspector (Context · Plan · Diff · Chat · Preview), checklist plan, and a persistent bottom status bar with live activity. Densest and most tool-like. Green 'run/merge' accent.">
        <DCArtboard id="workbench" label="E — Workbench" width={1440} height={900}><OpWorkbench /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<OpsApp />);
