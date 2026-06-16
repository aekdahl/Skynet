// Tower — Reimagined: design-canvas wrapper presenting the 5 desktop shells

function ReApp() {
  return (
    <DesignCanvas>
      <DCSection id="d1" title="1 · Operator" subtitle="Three-pane master–detail (sidebar · list · inspector) with a title bar and a status bar. The IDE / Linear / mail-client archetype — pick a blocker on the left, decide on the right.">
        <DCArtboard id="operator" label="Operator — three-pane" width={1440} height={900}><Operator /></DCArtboard>
      </DCSection>
      <DCSection id="d2" title="2 · Cockpit" subtitle="A dense, fixed mission-control dashboard — KPI strip, docked panels (needs-you, project lines, fleet capacity, live activity), nothing hidden. The Bloomberg-terminal archetype.">
        <DCArtboard id="cockpit" label="Cockpit — dense dashboard" width={1440} height={900}><Cockpit /></DCArtboard>
      </DCSection>
      <DCSection id="d3" title="3 · Studio" subtitle="A media-app: projects library on the left, a hero with the live product, and a persistent transport dock showing what's building right now + a global needs-you pill. The Spotify archetype.">
        <DCArtboard id="studio" label="Studio — media app" width={1440} height={900}><Studio /></DCArtboard>
      </DCSection>
      <DCSection id="d4" title="4 · Canvas" subtitle="A spatial OS: a menu bar, draggable project windows arranged in space (each showing its live build), a focused needs-you window, and a dock with badges. The macOS / Stage-Manager archetype.">
        <DCArtboard id="canvas" label="Canvas — spatial OS" width={1440} height={900}><Canvas /></DCArtboard>
      </DCSection>
      <DCSection id="d5" title="5 · Columns" subtitle="Parallel independent columns — Inbox · Running · Fleet · Timeline — each its own scroll, all in view at once. The TweetDeck / power-user archetype.">
        <DCArtboard id="columns" label="Columns — TweetDeck" width={1440} height={900}><Columns /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ReApp />);
