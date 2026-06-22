// Tower — URL routing / deep links.
//
// Maps the in-memory router state (view + lens + projectId + agentId) onto the
// location hash, so every view/project/agent/lens is a shareable link and the
// browser back/forward buttons navigate. Reloading a link restores the view.
//
// Hash-based (not History pushState *paths*) on purpose: Mission Control is loaded
// as a static HTML file, so path-based deep links would 404 on reload. The hash
// keeps everything client-side.
//
// URL grammar:
//   #/home/<lens>      home with a specific lens (subway | timeline | ledger | roster)
//   #/projects         projects overview
//   #/fleet            fleet
//   #/inbox            the queue / Inbox
//   #/project/<id>     a project detail page
//   #/agent/<id>       an agent detail page
// An empty/unknown hash resolves to home/subway.

(function () {
  const HOME_LENSES = ['subway', 'timeline', 'ledger', 'roster'];
  const DEFAULTS = { view: 'home', lens: 'subway', projectId: null, agentId: null };

  // The 'queue' view is presented as the Inbox; everything else maps 1:1.
  const VIEW_TO_SLUG = { home: 'home', projects: 'projects', fleet: 'fleet', queue: 'inbox', project: 'project', agent: 'agent' };
  const SLUG_TO_VIEW = { home: 'home', projects: 'projects', fleet: 'fleet', inbox: 'queue', project: 'project', agent: 'agent' };

  function encode({ view, lens, projectId, agentId }) {
    if (view === 'home') return '#/home/' + (HOME_LENSES.includes(lens) ? lens : 'subway');
    if (view === 'project') return '#/project/' + (projectId != null ? encodeURIComponent(projectId) : '');
    if (view === 'agent') return '#/agent/' + (agentId != null ? encodeURIComponent(agentId) : '');
    return '#/' + (VIEW_TO_SLUG[view] || 'home');
  }

  function decode(hash) {
    const raw = (hash || '').replace(/^#\/?/, '');
    const [slugRaw, paramRaw] = raw.split('/');
    const slug = (slugRaw || 'home').toLowerCase();
    const param = paramRaw ? decodeURIComponent(paramRaw) : null;
    const view = SLUG_TO_VIEW[slug] || 'home';
    const state = { ...DEFAULTS, view };
    if (view === 'home') state.lens = HOME_LENSES.includes(param) ? param : 'subway';
    else if (view === 'project') state.projectId = param;
    else if (view === 'agent') state.agentId = param;
    return state;
  }

  // React hook that owns the four routing fields and keeps them synced with the URL.
  // Drop-in replacement for the individual useState calls in App().
  function useTowerRouter() {
    const initial = React.useMemo(() => decode(window.location.hash), []);
    const [view, setView] = React.useState(initial.view);
    const [lens, setLens] = React.useState(initial.lens);
    const [projectId, setProjectId] = React.useState(initial.projectId);
    const [agentId, setAgentId] = React.useState(initial.agentId);
    const mounted = React.useRef(false);

    // state -> URL
    React.useEffect(() => {
      const next = encode({ view, lens, projectId, agentId });
      if (!mounted.current) {
        // First render: canonicalize the initial URL in place (e.g. "" -> "#/home/subway")
        // without pushing a spurious history entry.
        mounted.current = true;
        if (next !== window.location.hash) window.history.replaceState(null, '', next);
        return;
      }
      if (next !== window.location.hash) window.history.pushState(null, '', next);
    }, [view, lens, projectId, agentId]);

    // URL -> state (browser back/forward, address-bar edits, opening a shared link)
    React.useEffect(() => {
      const sync = () => {
        const s = decode(window.location.hash);
        setView(s.view); setLens(s.lens); setProjectId(s.projectId); setAgentId(s.agentId);
      };
      // pushState/replaceState don't fire these, so this only runs on genuine URL navigation.
      window.addEventListener('popstate', sync);
      window.addEventListener('hashchange', sync);
      return () => {
        window.removeEventListener('popstate', sync);
        window.removeEventListener('hashchange', sync);
      };
    }, []);

    return { view, setView, lens, setLens, projectId, setProjectId, agentId, setAgentId };
  }

  window.useTowerRouter = useTowerRouter;
  window.TowerRoute = { encode, decode };
})();
