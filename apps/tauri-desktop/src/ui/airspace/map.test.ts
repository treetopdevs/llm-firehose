// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { renderAirspaceMap } from './map';
import type { AirspaceRow } from './model';
const row = (id: string): AirspaceRow => ({ key: JSON.stringify(['codex', id]), session: { id, source: 'codex', state: 'working', events: 1, last: { event_id: id, source: 'codex', kind: 'activity', summary: '<script>captured</script>', time: '2026-10-18T12:00:00Z', observed_at: '2026-10-18T12:00:00Z' } }, band: 'recent', eventTime: 1, eventAgeMs: 60000, clockNote: 'Event time', workspace: '' });
const counts = { request: 0, failure: 0, recent: 21, quiet: 0, completion: 0 };
test('shows all bands and bounded keyboard markers with exact identity and explicit selection', () => {
    const selected = vi.fn(), root = renderAirspaceMap(Array.from({ length: 21 }, (_, i) => row(`session-${i}`)), counts, selected);
    expect(root.querySelectorAll('.airspace-band')).toHaveLength(5);
    expect(root.querySelectorAll('button')).toHaveLength(20);
    expect(root.textContent).toContain('21');
    expect(root.textContent).toContain('not time');
    expect(selected).not.toHaveBeenCalled();
    root.querySelector('button')!.click();
    expect(selected.mock.calls[0][0].key).toBe('["codex","session-0"]');
    expect(root.querySelector('button')!.getAttribute('aria-label')).toContain('codex / session-0');
    expect(root.querySelector('script')).toBeNull();
});
test('does not conflate identical native session IDs from different sources', () => {
    const a = row('same'), b = { ...row('same'), key: '["claude-code","same"]', session: { ...row('same').session, source: 'claude-code' } };
    const root = renderAirspaceMap([a, b], { ...counts, recent: 2 }, vi.fn());
    expect(root.querySelectorAll('button')).toHaveLength(2);
    expect(root.textContent).toContain('claude-code');
});
test('keeps marker summaries bounded while selection retains full observation', () => {
    const item = row('long');
    item.session.last.summary = 'x'.repeat(5000);
    const selected = vi.fn();
    const root = renderAirspaceMap([item], { ...counts, recent: 1 }, selected);
    expect(root.querySelector('small')!.textContent!.length).toBeLessThanOrEqual(121);
    root.querySelector('button')!.click();
    expect(selected.mock.calls[0][0].session.last.summary).toHaveLength(5000);
});
