const phases = { starting:'Starting', preflight:'Preflight', clone:'Preparing', plan:'Planning',
  implement:'Implementing', artifact:'Finishing' };
const tickets = document.getElementById('tickets');
const detail = document.getElementById('detail');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const connection = document.getElementById('connection');
let rows = [];
let selected = null;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function section(label, values) {
  if (!values?.length) return;
  detail.append(node('h3', 'section-label', label));
  const list = node('ul', 'report-list');
  for (const value of values) list.append(node('li', '', value));
  detail.append(list);
}

function renderDetail() {
  detail.replaceChildren();
  const row = rows.find(item => item.runId === selected);
  if (!row) {
    const placeholder = node('div', 'placeholder');
    placeholder.append(node('span', 'placeholder-icon', '↗'), node('h2', '', 'Select a ticket'),
      node('p', '', 'Choose a run to see its latest Luna observation.'));
    detail.append(placeholder);
    return;
  }
  const heading = node('div', 'detail-heading');
  heading.append(node('span', 'eyebrow', row.ticketId), node('h2', '', row.ticketName),
    node('p', '', `Run ${row.runId}`));
  detail.append(heading);
  const line = node('div', 'status-line');
  line.append(node('span', 'status-pill', phases[row.phase] || 'Working'));
  if (row.report) line.append(node('span', 'report-time', `Report #${row.report.number} · ${new Date(row.report.finishedAtMs).toLocaleString()}`));
  detail.append(line);
  if (!row.report) {
    detail.append(node('p', 'muted', 'No Luna report yet for this phase. The phase above comes from the live runner.'));
    return;
  }
  const card = node('div', 'action-card');
  card.append(node('span', '', 'Current action'), node('p', '', row.report.currentAction));
  detail.append(card);
  section('Evidence', row.report.evidence);
  section('Risks', row.report.risks);
  section('Stalls', row.report.stalls);
  const foot = node('div', 'report-foot');
  foot.append(node('strong', '', `Confidence: ${row.report.confidence}`),
    document.createTextNode(` · ${row.report.status === 'unavailable' ? 'Assessment unavailable' : 'Luna observation only'}`));
  detail.append(foot);
}

function render() {
  count.textContent = String(rows.length);
  empty.hidden = rows.length !== 0;
  if (!rows.some(item => item.runId === selected)) selected = rows[0]?.runId || null;
  const focused = document.activeElement?.dataset?.runId;
  const buttons = rows.map(row => {
    const button = node('button', `ticket${row.runId === selected ? ' selected' : ''}`);
    button.type = 'button';
    button.dataset.runId = row.runId;
    button.setAttribute('aria-pressed', String(row.runId === selected));
    const top = node('span', 'ticket-row');
    top.append(node('span', 'ticket-id', row.ticketId), node('span', 'phase', phases[row.phase] || 'Working'));
    button.append(top, node('span', 'ticket-name', row.ticketName));
    button.addEventListener('click', () => { selected = row.runId; render(); });
    return button;
  });
  tickets.replaceChildren(...buttons);
  if (focused) buttons.find(button => button.dataset.runId === focused)?.focus({ preventScroll:true });
  renderDetail();
}

async function refresh() {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch('api/runs', { cache:'no-store', signal:controller.signal });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const next = await response.json();
    if (!Array.isArray(next)) throw new Error('Invalid snapshot');
    rows = next;
    empty.querySelector('strong').textContent = 'Nothing running right now';
    empty.querySelector('span:last-child').textContent = 'Tickets appear here while Squire is active.';
    connection.textContent = 'Live';
    connection.parentElement.classList.remove('offline');
    render();
  } catch {
    rows = [];
    selected = null;
    connection.textContent = 'Status unavailable';
    connection.parentElement.classList.add('offline');
    render();
    empty.querySelector('strong').textContent = 'Status unavailable';
    empty.querySelector('span:last-child').textContent = 'The local status service is not responding.';
  } finally {
    clearTimeout(deadline);
    setTimeout(() => { void refresh(); }, 3_000);
  }
}

void refresh();
