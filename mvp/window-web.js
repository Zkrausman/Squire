import { projectDashboard, restoreSelection } from './window-view.mjs';

const phases = [
  ['starting', 'Starting'], ['preflight', 'Preflight'], ['clone', 'Preparing'],
  ['plan', 'Planning'], ['implement', 'Implementing'], ['artifact', 'Finishing'],
];
const STORAGE_KEY = 'squire.active-window.selected-run.v1';
const tickets = document.getElementById('tickets');
const detail = document.getElementById('detail');
const empty = document.getElementById('empty');
const emptyTitle = document.getElementById('empty-title');
const emptyMessage = document.getElementById('empty-message');
const count = document.getElementById('count');
const summaryTicket = document.getElementById('summary-ticket');
const summaryHeartbeat = document.getElementById('summary-heartbeat');
const connection = document.getElementById('connection');
const connectionText = document.getElementById('connection-text');
const clock = document.getElementById('clock');
let rows = [];
let selected = readSelected();
let snapshotState = 'connecting';

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function readSelected() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function saveSelected(runId) {
  try {
    if (runId) localStorage.setItem(STORAGE_KEY, runId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* Local persistence is optional. */ }
}

function phaseName(phase) {
  return phases.find(([key]) => key === phase)?.[1] || 'Unavailable';
}

function formattedTime(milliseconds) {
  return new Date(milliseconds).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function appendTime(parent, label, milliseconds) {
  const item = node('span', '', `${label} `);
  const time = node('time', '', formattedTime(milliseconds));
  time.dateTime = new Date(milliseconds).toISOString();
  item.append(time);
  parent.append(item);
}

function ageText(ageMs) {
  const seconds = Math.floor(Math.max(0, ageMs) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

function section(label, values, absence) {
  const panel = node('section', 'report-section');
  panel.setAttribute('aria-label', `${label}, Luna observation`);
  panel.append(node('h3', 'section-label', label));
  const list = node('ul', 'report-list');
  if (values?.length) {
    for (const value of values) list.append(node('li', '', value));
  } else {
    list.append(node('li', 'not-reported', absence));
  }
  panel.append(list);
  return panel;
}

function reportMessage(row) {
  if (row.reportState === 'not-reported') return 'No Luna observation reported for this phase.';
  if (row.reportState === 'unavailable') return 'Luna observation unavailable. No observation content is shown.';
  if (row.reportState === 'stale') return `Stale Luna observation · ${ageText(row.report.ageMs)} old.`;
  return `Luna observation · Report #${row.report.number} · ${formattedTime(row.report.finishedAtMs)}.`;
}

function renderDetail() {
  detail.replaceChildren();
  const row = rows.find(item => item.runId === selected);
  if (!row) {
    const unavailable = rows.length === 0 && snapshotState !== 'live';
    const placeholder = node('div', 'placeholder');
    placeholder.append(node('span', 'placeholder-icon', unavailable ? '!' : '↗'),
      node('h2', '', unavailable ? 'Run status unavailable' : 'No active run selected'),
      node('p', '', unavailable
        ? 'The local status response could not be validated. Previous rows are not shown as live.'
        : 'Run details appear when an active runner record is available.'));
    detail.append(placeholder);
    return;
  }

  const heading = node('div', 'detail-heading');
  heading.append(node('span', 'eyebrow', `${row.ticketId} · RUNNER PHASE`),
    node('h2', '', row.ticketName), node('p', '', `Run ${row.runId}`),
    node('span', 'runner-phase', phaseName(row.phase)));
  detail.append(heading);

  const metadata = node('div', 'metadata');
  appendTime(metadata, 'Runner process start:', row.processStartMs);
  if (row.heartbeatState === 'available') {
    metadata.append(node('span', '', `Runner heartbeat: updated ${ageText(row.heartbeatAgeMs)}`));
    appendTime(metadata, 'Last update:', row.updatedAtMs);
  } else if (row.heartbeatState === 'stale') {
    metadata.append(node('span', 'observation-status stale', 'Runner heartbeat: stale'));
    appendTime(metadata, 'Last update:', row.updatedAtMs);
  } else {
    metadata.append(node('span', 'observation-status unavailable', 'Runner heartbeat timestamp unavailable'));
  }
  detail.append(metadata);

  const phaseBlock = node('div', 'phase-block');
  phaseBlock.append(node('span', 'eyebrow', 'RUNNER PHASE RAIL'));
  const rail = node('ol', 'phase-rail');
  rail.setAttribute('aria-label', 'Runner phase progression');
  const currentIndex = phases.findIndex(([key]) => key === row.phase);
  phases.forEach(([key, label], index) => {
    const step = node('li', index === currentIndex ? 'current' : index < currentIndex ? 'earlier' : '', label);
    step.setAttribute('aria-label', `${label}${index === currentIndex ? ', current runner phase' : ''}`);
    if (index === currentIndex) step.setAttribute('aria-current', 'step');
    rail.append(step);
  });
  phaseBlock.append(rail);
  detail.append(phaseBlock);

  const observation = node('section', 'observation');
  observation.setAttribute('aria-label', 'Luna observation');
  observation.append(node('div', 'observation-label', 'Luna-reported current work'));
  if (row.report && ['available', 'stale'].includes(row.reportState)) {
    observation.append(node('p', '', row.report.currentAction));
    observation.append(node('div', `observation-status${row.reportState === 'stale' ? ' stale' : ''}`,
      reportMessage(row)));
  } else {
    observation.append(node('p', 'muted', row.reportState === 'not-reported'
      ? 'Not reported for the current phase.' : 'Unavailable; no current work is inferred.'));
    observation.append(node('div', `observation-status${row.reportState === 'unavailable' ? ' unavailable' : ''}`,
      reportMessage(row)));
  }
  detail.append(observation);

  const validReport = row.report && ['available', 'stale'].includes(row.reportState) ? row.report : null;
  const absence = row.reportState === 'not-reported' ? 'Not reported by current sources.'
    : row.reportState === 'unavailable' ? 'Unavailable from the current observation.'
      : 'Not reported in this Luna observation.';
  const sections = node('div', 'sections');
  sections.append(section('Evidence · Luna', validReport?.evidence, absence),
    section('Risks · Luna', validReport?.risks, absence),
    section('Stalls · Luna', validReport?.stalls, absence));
  detail.append(sections);

  const provenance = node('p', 'provenance');
  provenance.append(node('strong', '', 'Provenance: '),
    document.createTextNode('phase and timestamps from the explicit runner record; observations from Luna, not independent checks or approval.'));
  if (validReport) provenance.append(document.createTextNode(` Luna-reported confidence: ${validReport.confidence}.`));
  detail.append(provenance);
}

function render() {
  const selectedRow = rows.find(item => item.runId === selected);
  const focusedRunId = document.activeElement?.dataset?.runId;
  count.textContent = snapshotState === 'live' ? String(rows.length) : '—';
  summaryTicket.textContent = selectedRow ? `${selectedRow.ticketId} · ${selectedRow.ticketName}` : '—';
  summaryHeartbeat.textContent = !selectedRow ? '—'
    : selectedRow.heartbeatState === 'available' ? `Updated ${ageText(selectedRow.heartbeatAgeMs)}`
      : selectedRow.heartbeatState === 'stale' ? 'Stale' : 'Unavailable';

  connection.classList.toggle('offline', snapshotState === 'unavailable');
  connection.classList.toggle('partial', snapshotState === 'partial');
  const connectionLabel = snapshotState === 'live' ? 'Live status'
    : snapshotState === 'partial' ? 'Partial status'
      : snapshotState === 'connecting' ? 'Connecting' : 'Status unavailable';
  if (connectionText.textContent !== connectionLabel) connectionText.textContent = connectionLabel;
  empty.hidden = rows.length > 0;
  if (snapshotState === 'unavailable') {
    emptyTitle.textContent = 'Status unavailable';
    emptyMessage.textContent = 'No previous rows are presented as live. The local status response could not be validated.';
  } else if (snapshotState === 'partial') {
    emptyTitle.textContent = 'Run data unavailable';
    emptyMessage.textContent = 'The response contained no valid active runner records.';
  } else {
    emptyTitle.textContent = 'No active runs reported';
    emptyMessage.textContent = 'Only live, opted-in runner records appear here.';
  }

  const buttons = rows.map(row => {
    const button = node('button', `ticket${row.runId === selected ? ' selected' : ''}`);
    button.type = 'button';
    button.dataset.runId = row.runId;
    button.setAttribute('aria-pressed', String(row.runId === selected));
    const top = node('span', 'ticket-row');
    top.append(node('span', 'ticket-id', row.ticketId), node('span', 'phase', phaseName(row.phase)));
    button.append(top, node('span', 'ticket-name', row.ticketName), node('span', 'run-id', `Run ${row.runId}`));
    button.addEventListener('click', () => {
      selected = row.runId;
      saveSelected(selected);
      render();
    });
    return button;
  });
  tickets.replaceChildren(...buttons);
  if (focusedRunId) buttons.find(button => button.dataset.runId === focusedRunId)?.focus({ preventScroll: true });
  renderDetail();
}

function updateClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  clock.dateTime = now.toISOString();
}

async function refresh() {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch('api/runs', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const next = await response.json();
    const projection = projectDashboard(next, Date.now());
    rows = projection.rows;
    snapshotState = projection.invalidRows === 0 ? 'live' : rows.length ? 'partial' : 'unavailable';
    const previous = selected;
    selected = restoreSelection(rows, selected);
    if (selected !== previous) saveSelected(selected);
  } catch {
    rows = [];
    snapshotState = 'unavailable';
  } finally {
    clearTimeout(deadline);
    render();
    setTimeout(() => { void refresh(); }, 3_000);
  }
}

updateClock();
setInterval(updateClock, 1_000);
void refresh();
