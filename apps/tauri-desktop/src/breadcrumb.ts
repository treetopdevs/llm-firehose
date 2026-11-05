// Footer breadcrumb: project › worktree › session, read from the shared scope.
// Labels come from the scope resolver (graph-space); unresolved segments fall
// back to a short id. No network: event-space ids cannot be joined honestly to
// graph ids, so this module never fetches.
import { idLabel, projectName, sessionRefLabel, worktreeName } from './format';
import type { SessionDirectory } from './session-directory';
import type { Scope, ScopeStore } from './scope';

const SEP = ' › ';

export function createBreadcrumb(store: ScopeStore, opts: { directory?: SessionDirectory } = {}): { root: HTMLElement; destroy(): void } {
  const root = document.createElement('span');
  root.className = 'crumb';
  let key = '';

  const directory = opts.directory;
  const sessionLabel = (s: Scope) => (s.session ? sessionRefLabel(s.session, directory?.lookup(s.session)) : null);

  // The resolved session label is part of the key, so a late name re-renders and an unrelated notify does not.
  const keyOf = (s: Scope) =>
    JSON.stringify([s.project ?? null, s.worktree ?? null, s.session ? [s.session.id, s.session.source ?? null, sessionLabel(s)] : null]);

  const segment = (full: string, label: string | undefined, resolved = !!label, name?: (id: string, r?: string) => { label: string }): HTMLElement => {
    const seg = document.createElement('span');
    seg.title = full;
    seg.textContent = name ? name(full, label).label : label || idLabel(full);
    if (!resolved) seg.className = 'unresolved';
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
    if (s.project) parts.push(segment(s.project, labels.project, !!labels.project, projectName));
    if (s.worktree) parts.push(segment(s.worktree, labels.worktree, !!labels.worktree, worktreeName));
    if (s.session) {
      const ref = sessionLabel(s)!;
      parts.push(segment(s.session.id, ref.label, ref.resolved));
      directory?.ensure(s.session);
    }
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
  const offResolver = store.onResolver(() => {
    key = keyOf(store.get());
    render();
  });
  const offDirectory = directory?.subscribe(() => {
    const k = keyOf(store.get());
    if (k === key) return;
    key = k;
    render();
  });

  return {
    root,
    destroy() {
      offScope();
      offResolver();
      offDirectory?.();
    },
  };
}
