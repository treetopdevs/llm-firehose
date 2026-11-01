// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { renderHandoffMap } from './map';
import type { Handoff } from './model';
const links: Handoff[] = Array.from({ length: 11 }, (_, i) => ({ id: `link-${i}`, label: '<script>annotation</script>', from: { id: `from-${i}`, source: 'codex', session_id: 'departure' }, to: { id: `to-${i}`, source: 'claude', session_id: 'arrival' } }));
test('bounds page map, exposes keyboard station controls, and only inspects on request', () => {
    const inspect = vi.fn(), root = renderHandoffMap(links, inspect);
    expect(root.querySelectorAll('button')).toHaveLength(20);
    expect(root.querySelectorAll('path[data-transfer]')).toHaveLength(10);
    expect(root.querySelector('script')).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    const button = root.querySelector('button')!;
    button.click();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-label')).toContain(inspect.mock.calls[0][0].id);
    expect(root.textContent).toContain('not time');
});
test('reuses shared stations and keeps arrow markers unique across maps', () => {
    const a = renderHandoffMap([links[0], { ...links[1], from: links[0].from }], vi.fn());
    const b = renderHandoffMap([links[0]], vi.fn());
    expect(a.querySelectorAll('button')).toHaveLength(3);
    expect(a.querySelector('marker')?.id).not.toBe(b.querySelector('marker')?.id);
});
test("transfer arrows stop outside station dots", () => {
    const root = renderHandoffMap([links[0]], vi.fn());
    const path = root.querySelector("path[data-transfer]")!;
    expect(path.getAttribute("d")).toBe("M 305 162 C 210 162, 210 90, 117 90");
});
test("names session lanes and station labels but never renames event ids", () => {
    const named = (ref: { id: string; source: string }) => ref.id === 'departure' ? 'Fix login bug' : ref.id;
    const root = renderHandoffMap([links[0], { ...links[1], from: { ...links[1].from, id: 'from-other', session_id: 'departure' } }], vi.fn(), named);
    expect(root.textContent).toContain('codex · Fix login bug');
    const labels = [...root.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
    expect(labels.filter(l => l!.includes('Fix login bug'))).toHaveLength(2);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some(l => l!.includes('from-other'))).toBe(true);
    expect([...root.querySelectorAll('button')].map(b => b.textContent)).toContain('from-0');
});
