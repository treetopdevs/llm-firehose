import { el } from '../../dom';
import { BANDS, type AirspaceRow, type Band } from './model';
/** Bounded visual index. Marker positions encode band membership only. */
export function renderAirspaceMap(rows: AirspaceRow[], counts: Record<Band, number>, onSelect: (row: AirspaceRow) => void): HTMLElement {
    const root = el('section', { class: 'airspace-map', 'aria-label': 'Observation bands' }, el('p', { class: 'dim' }, 'Map and list show the current page only; totals include all filtered sessions. Position shows band membership, not time, duration, or process status.'));
    const page = rows.slice(0, 20);
    for (const band of BANDS) {
        const heading = el('h3', { class: 'airspace-band-title' }, `${band.label} · ${counts[band.id]}`);
        const markers = el('div', { class: 'airspace-markers' });
        markers.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;min-height:40px;align-items:center';
        const section = el('section', { class: 'airspace-band', 'data-band': band.id }, heading, markers);
        section.style.cssText = 'display:grid;grid-template-columns:minmax(130px,180px) minmax(0,1fr);gap:12px;padding:8px 10px;border-top:1px solid var(--border,#34404e)';
        const members = page.filter(row => row.band === band.id);
        if (!members.length)
            markers.append(el('span', { class: 'dim' }, counts[band.id] ? 'No markers on this page' : 'No observations in this band'));
        for (const row of members) {
            const summary = row.session.pending?.summary || row.session.last.summary || 'No summary captured';
            const marker = el('button', { class: 'airspace-marker', type: 'button', 'aria-label': `Inspect ${band.label}: ${row.session.source} / ${row.session.id}`, title: `${row.session.source} / ${row.session.id}` }, el('span', {}, `${row.session.source} · ${row.session.id.slice(0, 12)}`), el('small', {}, summary.length > 120 ? summary.slice(0, 120) + '…' : summary));
            marker.style.cssText = 'box-sizing:border-box;width:200px;max-width:100%;text-align:left;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere';
            marker.addEventListener('click', () => onSelect(row));
            markers.append(marker);
        }
        root.append(section);
    }
    return root;
}
