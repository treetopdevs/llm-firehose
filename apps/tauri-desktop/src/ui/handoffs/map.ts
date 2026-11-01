import { buildHandoffMap, type Endpoint, type Handoff } from './model';
let renderId = 0;
const colors = ['#73b7ff', '#b59aff', '#76d7ba', '#f2ba72', '#ee91b0'];
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs))
        node.setAttribute(key, value);
    return node;
}
/** The map is a page-sized index of annotations, never a clock or inferred trace. */
/** `nameOf` names a session reference; event ids are never renamed. */
export function renderHandoffMap(links: Handoff[], onInspect: (endpoint: Endpoint) => void, nameOf: (ref: { id: string; source: string }) => string = ref => ref.id): HTMLElement {
    const map = buildHandoffMap(links.slice(0, 10));
    const root = document.createElement('section');
    root.className = 'handoff-map';
    const description = document.createElement('p');
    description.textContent = 'Current page only. Stations group captured references by source and session; positions are not time, duration, or effort. Arrows are user annotations.';
    root.append(description);
    if (!map.stations.length)
        return root;
    const scroll = document.createElement('div');
    scroll.style.overflowX = 'auto';
    const canvas = document.createElement('div');
    canvas.style.position = 'relative';
    const width = Math.max(600, map.lanes.length * 210), height = Math.max(250, map.stations.length * 72 + 110);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    scroll.append(canvas);
    root.append(scroll);
    const drawing = svg('svg', { width: String(width), height: String(height), 'aria-hidden': 'true' });
    drawing.style.position = 'absolute';
    canvas.append(drawing);
    const markerId = `handoff-arrow-${++renderId}`;
    const defs = svg('defs', {}), marker = svg('marker', { id: markerId, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' }));
    defs.append(marker);
    drawing.append(defs);
    const x = (lane: number) => 105 + lane * 210;
    map.lanes.forEach((lane, i) => {
        drawing.append(svg('line', { x1: String(x(i)), x2: String(x(i)), y1: '55', y2: String(height - 20), stroke: colors[i % colors.length], 'stroke-width': '4', opacity: '.5' }));
        const label = document.createElement('div');
        label.style.cssText = `position:absolute;left:${x(i) - 95}px;top:4px;width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
        label.textContent = `${lane.source} · ${nameOf({ id: lane.session_id, source: lane.source })}`;
        label.title = `${lane.source} / ${lane.session_id}`;
        canvas.append(label);
    });
    const positions = new Map(map.stations.map((station, i) => [station.key, { x: x(station.lane), y: 90 + i * 72 }]));
    map.edges.forEach(edge => {
        const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
        const direction = Math.sign(to.x - from.x), middle = (from.x + to.x) / 2;
        const path = svg('path', { d: `M ${from.x + direction * 10} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x - direction * 12} ${to.y}`, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'marker-end': `url(#${markerId})`, 'data-transfer': edge.id });
        const title = svg('title', {});
        title.textContent = `${edge.label}: ${edge.from} → ${edge.to}`;
        path.append(title);
        drawing.append(path);
    });
    map.stations.forEach(station => {
        const position = positions.get(station.key)!;
        drawing.append(svg('circle', { cx: String(position.x), cy: String(position.y), r: '7', fill: colors[station.lane % colors.length] }));
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = station.endpoint.id.slice(0, 12);
        button.title = station.endpoint.id;
        button.setAttribute('aria-label', `Inspect station ${station.endpoint.source} / ${nameOf({ id: station.endpoint.session_id, source: station.endpoint.source })} / ${station.endpoint.id}`);
        button.style.cssText = `position:absolute;left:${position.x - 80}px;top:${position.y + 10}px;width:160px;overflow:hidden;text-overflow:ellipsis`;
        button.addEventListener('click', () => onInspect({ ...station.endpoint }));
        canvas.append(button);
    });
    return root;
}
