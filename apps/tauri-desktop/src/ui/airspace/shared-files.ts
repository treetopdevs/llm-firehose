import { capturedEvent, fileSessions } from '../../api';
import type { AttentionSession, FileSession } from '../../api';
import { clear, el } from '../../dom';
import { matchesFileReceipt } from '../files';
import { stripControl } from '../score/model';
import { sharedFileLanes } from './shared-files-model';

const button = (label: string, action: () => void) => {
  const result = el('button', {}, label);
  result.addEventListener('click', action);
  return result;
};
export function createSharedFiles(now: () => number = Date.now) {
  const heading = el('h3', { tabindex: '-1' }, 'Shared recorded files');
  const notice = el('p', { role: 'status', class: 'airspace-notice' });
  const body = el('section', { 'aria-label': 'Shared file lanes' });
  const receipt = el('section', { 'aria-label': 'Shared file receipt', tabindex: '-1' });
  const load = button('Load shared files', () => void refresh());
  const retry = button('Retry shared files', () => void refresh());
  const root = el('section', { 'aria-label': 'Shared recorded files' }, heading,
    el('p', { class: 'dim' }, 'Historical recorded strings, not simultaneous activity or physical file identity. No lane does not prove no shared file: privacy digests, relative/absolute paths, symlinks, case and truncation can hide matches. A relative path under a shared worktree may name different files in different working directories.'),
    el('p', { class: 'dim' }, 'Workspace/search/source filters select attention sessions, not their historical file scopes. The recent window changes attention bands only. These snapshots are fetched separately and are not atomic. Full historical data is loaded in memory; pagination bounds rendering only.'), load, retry, notice, receipt, body);
  let sessions: readonly AttentionSession[] = [], rows: FileSession[] | undefined;
  let attentionStale = true, attentionTime: number | undefined, attentionAvailable = false;
  let active = true, connected = true, stale = true, loading = false, error = '', fetchedAt: number | undefined, page = 0;
  let membership = '';
  let listToken = 0, detailToken = 0, listAbort: AbortController | undefined, detailAbort: AbortController | undefined;
  const timestamp = (n: number | undefined) => n === undefined ? 'not fetched' : new Date(n).toISOString();
  function cancelReceipt() { detailToken++; detailAbort?.abort(); clear(receipt); }
  function invalidateList() { listToken++; listAbort?.abort(); loading = false; }
  function draw() {
    load.textContent = rows ? 'Refresh shared files' : 'Load shared files';
    load.disabled = !active || !connected;
    retry.hidden = !error; retry.disabled = !active || !connected;
    const statusText = `${!connected ? 'Disconnected. ' : ''}${loading ? 'Loading shared files. ' : ''}Files ${stale ? 'stale' : 'checked'} at ${timestamp(fetchedAt)}. Attention ${attentionStale ? 'stale' : 'checked'} at ${timestamp(attentionTime)}. ${error}`;
    if (notice.textContent !== statusText) notice.textContent = statusText;
    notice.classList.toggle('stale', stale || attentionStale || !connected);
    clear(body);
    if (!attentionAvailable) { body.append(el('p', {}, 'Waiting for an attention snapshot. Loaded file rows will be retained.')); return; }
    if (!rows) { body.append(el('p', {}, 'Load shared files to inspect recorded file observations.')); return; }
    const lanes = sharedFileLanes(rows, sessions);
    const participants = lanes.flatMap((lane, laneIndex) => lane.members.map((member, memberIndex) => ({ lane, member, laneIndex, memberIndex })));
    if (stale || attentionStale || !connected) body.append(el('p', { class: 'airspace-notice stale' }, 'Stale shared-file lanes — one or both snapshots need refresh.'));
    page = Math.min(page, Math.max(0, Math.ceil(participants.length / 40) - 1));
    body.append(el('p', {}, `${lanes.length} shared file lanes; ${participants.length} participants. Showing ${participants.length ? page * 40 + 1 : 0}–${Math.min((page + 1) * 40, participants.length)}. Lanes may continue across pages.`));
    if (!lanes.length) body.append(el('p', {}, 'No shared recorded files match these exact strings and eligible sessions. No lane does not prove no shared file.'));
    let previous = '';
    let list: HTMLOListElement | undefined;
    const visible = participants.slice(page * 40, page * 40 + 40);
    for (const { lane, member, laneIndex, memberIndex } of visible) {
      const key = JSON.stringify([lane.workspace_kind, lane.workspace, lane.path]);
      if (key !== previous) {
        previous = key;
        const scope = /^[a-f0-9]{64}$/i.test(lane.workspace) ? ' (opaque recorded identity)' : '';
        body.append(el('h4', { class: 'mono', style: 'overflow-wrap:anywhere;white-space:pre-wrap' }, stripControl(lane.path)), el('p', { class: 'mono', style: 'overflow-wrap:anywhere;white-space:pre-wrap' }, `${stripControl(lane.workspace_kind)}: ${stripControl(lane.workspace)}${scope}`));
        const shown = visible.filter(item => item.lane === lane).length;
        body.append(el('p', {}, `Lane ${laneIndex + 1}: participants ${memberIndex + 1}–${memberIndex + shown} of ${lane.members.length}.`));
        list = el('ol', { 'aria-label': `File lane ${laneIndex + 1}: ${stripControl(lane.path)}`, start: String(memberIndex + 1) }); body.append(list);
      }
      const name = `${stripControl(member.source)} / ${stripControl(member.session_id)}`;
      const inspect = button(`Inspect latest file observation: ${name}`, () => void inspectFile(member, inspect));
      inspect.setAttribute('aria-label', `Inspect latest file observation: ${name}; ${stripControl(lane.path)}; ${stripControl(lane.workspace_kind)}: ${stripControl(lane.workspace)}; lane ${laneIndex + 1}, participant ${memberIndex + 1}`);
      inspect.disabled = !member.last_event_id || !connected || !active;
      list!.append(el('li', { 'data-file-participant': '', style: 'overflow-wrap:anywhere' }, el('strong', {}, name),
        el('p', {}, `${member.events} observations (write-tool starts, ends and failures, not edits). All-history recorded range: ${stripControl(member.first_time)} to ${stripControl(member.last_time)}.`), inspect));
    }
    if (participants.length > 40) {
      const previousButton = button('Previous file participants', () => { cancelReceipt(); page--; draw(); heading.focus(); });
      const nextButton = button('Next file participants', () => { cancelReceipt(); page++; draw(); heading.focus(); });
      previousButton.disabled = page === 0; nextButton.disabled = (page + 1) * 40 >= participants.length;
      body.append(previousButton, nextButton);
    }
  }
  async function inspectFile(row: FileSession, opener: HTMLButtonElement) {
    cancelReceipt();
    if (!active || !connected || !row.last_event_id) return;
    const token = detailToken, ctl = new AbortController(); detailAbort = ctl;
    receipt.append(el('p', { role: 'status' }, 'Loading file receipt…'));
    try {
      const event = await capturedEvent(row.last_event_id, ctl.signal);
      if (ctl.signal.aborted || token !== detailToken || !active || !connected) return;
      if (!matchesFileReceipt(row, event)) throw Error('Recorded identity or path mismatch');
      clear(receipt);
      receipt.append(el('h4', {}, 'Latest recorded file observation for this participant'), el('p', {}, 'This single receipt does not prove sharing or verify the other observations in the lane.'), el('pre', {}, JSON.stringify(event, null, 2)));
    } catch (cause) {
      if (ctl.signal.aborted || token !== detailToken) return;
      clear(receipt); receipt.append(el('p', { role: 'alert' }, `Receipt unavailable: ${cause instanceof Error ? cause.message : String(cause)}`), button('Retry file receipt', () => void inspectFile(row, opener)));
    }
    receipt.append(button('Close file receipt', () => { cancelReceipt(); (opener.isConnected ? opener : heading).focus(); }));
    receipt.focus();
  }
  async function refresh() {
    invalidateList(); cancelReceipt(); stale = true; error = '';
    if (!active || !connected) { draw(); return; }
    const token = listToken, ctl = new AbortController(); listAbort = ctl; loading = true; draw();
    try {
      const result = await fileSessions(ctl.signal);
      if (ctl.signal.aborted || token !== listToken || !active || !connected) return;
      rows = result; fetchedAt = now(); stale = false; page = 0;
    } catch (cause) {
      if (ctl.signal.aborted || token !== listToken) return;
      error = `Refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally { if (token === listToken) { loading = false; draw(); } }
  }
  function setSessions(next: readonly AttentionSession[], isStale: boolean, time?: number, available = true) {
    const nextMembership = JSON.stringify([...new Set(next.map(s => JSON.stringify([s.source, s.id])))].sort());
    const changed = nextMembership !== membership || available !== attentionAvailable;
    if (!changed && attentionStale === isStale && attentionTime === time) return;
    if (changed) { cancelReceipt(); page = 0; }
    membership = nextMembership; sessions = next; attentionStale = isStale; attentionTime = time; attentionAvailable = available; draw();
  }
  function filtersChanged() { if (loading) error = "Shared-file load cancelled because filters changed. Load again when ready."; invalidateList(); cancelReceipt(); page = 0; draw(); }
  function deactivate() { active = false; stale = true; invalidateList(); cancelReceipt(); draw(); }
  function activate() { active = true; stale = true; draw(); }
  function setConnected(value: boolean) { if (value === connected) return; connected = value; stale = true; invalidateList(); cancelReceipt(); draw(); }
  draw();
  return { root, setSessions, deactivate, activate, setConnected, cancelReceipt, filtersChanged };
}
