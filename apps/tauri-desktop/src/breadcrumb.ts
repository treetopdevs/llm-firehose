// Footer breadcrumb: project › worktree › session, read from the shared scope.
// Labels come from the scope resolver (graph-space); unresolved segments fall
// back to a short id. No network: event-space ids cannot be joined honestly to
// graph ids, so this module never fetches.
import { idLabel } from './format';
import type { Scope, ScopeStore } from './scope';

const SEP = ' › ';

export function createBreadcrumb(store: ScopeStore): { root: HTMLElement; destroy(): void } {
  const root = document.createElement('span');
  root.className = 'crumb';
  let key = '';

  const keyOf = (s: Scope) =>
    JSON.stringify([s.project ?? null, s.worktree ?? null, s.session ? [s.session.id, s.session.source ?? null] : null]);

  const segment = (full: string, label: string | undefined): HTMLElement => {
    const seg = document.createElement('span');
    seg.title = full;
    if (label) seg.textContent = label;
    else {
      seg.className = 'unresolved';
      seg.textContent = idLabel(full);
    }
    return seg;
  };

  const render = () => {
    const s = store.get();
    let labels: { project?: string; worktree?: string } = {};
    try {
      labels = store.resolver()?.labels(s) ?? {};
    } catch {
      labels = {};
    }
    const parts: HTMLElement[] = [];
    if (s.project) parts.push(segment(s.project, labels.project));
    if (s.worktree) parts.push(segment(s.worktree, labels.worktree));
    if (s.session) parts.push(segment(s.session.id, undefined));
    const nodes: Node[] = [];
    parts.forEach((p, i) => {
      if (i) nodes.push(document.createTextNode(SEP));
      nodes.push(p);
    });
    root.replaceChildren(...nodes);
  };

  key = keyOf(store.get());
  render();
  const offScope = store.subscribe((next) => {
    const k = keyOf(next);
    if (k === key) return;
    key = k;
    render();
  });
  const offResolver = store.onResolver(render);

  return {
    root,
    destroy() {
      offScope();
      offResolver();
    },
  };
}
