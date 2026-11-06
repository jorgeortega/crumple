// Everything shown comes from a response, so it only ever goes in as text, never as HTML.

const result = document.getElementById('result');
const buttons = [...document.querySelectorAll('button[data-scenario]')];

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Wide text scrolls sideways, so a keyboard has to be able to reach it too.
function scrollable(text) {
  const block = make('pre', '', text);
  block.tabIndex = 0;
  return block;
}

function showMessage(text) {
  result.replaceChildren(make('p', 'waiting', text));
}

function showReport(report) {
  const verdict = report.held ? 'Held, on this run' : 'Did not hold, on this run';
  const parts = [
    make('p', `verdict ${report.held ? 'held' : 'broke'}`, verdict),
    make('p', 'headline', report.headline),
  ];

  const facts = make('dl');
  for (const { label, value } of report.facts) {
    const row = make('div');
    row.append(make('dt', '', label), make('dd', '', value));
    facts.append(row);
  }
  parts.push(facts);

  parts.push(make('h3', '', 'What the API received'));
  if (report.api.length === 0) {
    parts.push(make('p', '', 'Nothing.'));
  } else {
    const lines = report.api.map(({ method, path, outcome }) => `${method} ${path}  ${outcome}`);
    parts.push(scrollable(lines.join('\n')));
  }

  parts.push(make('h3', '', "Crumple's own trace"));
  parts.push(scrollable(report.trace || 'No spans.'));
  parts.push(make('p', 'note', "On Cloudflare the clock only moves between waits, so work that's only computing shows as 0 ms. A wait, such as the deadline, shows its real time."));
  result.replaceChildren(...parts);
}

async function press(button) {
  for (const other of buttons) other.disabled = true;
  showMessage(`Running "${button.textContent}"...`);
  // On a phone the answer appears below the fold, and a press with nothing to see looks broken.
  if (result.getBoundingClientRect().top > window.innerHeight / 2) result.scrollIntoView({ block: 'start' });
  try {
    const response = await fetch(`/try/${button.dataset.scenario}`, { method: 'POST' });
    const body = await response.json();
    if (response.ok) showReport(body);
    else showMessage(body.error || `The server answered ${response.status}.`);
  } catch {
    showMessage("Couldn't reach the server. Check your connection, and try again.");
  } finally {
    for (const other of buttons) other.disabled = false;
  }
}

for (const button of buttons) button.addEventListener('click', () => { void press(button); });

const STATES = {
  pass: ['Passed', 'pass'],
  fail: ['Failed', 'fail'],
  partly: ['Partly', 'other'],
  not_run: ['Not run', 'other'],
};

async function loadClaims() {
  const source = document.getElementById('claims-source');
  const table = document.getElementById('claims');
  try {
    const response = await fetch('/proof.json');
    if (!response.ok) throw new Error('No report.');
    const proof = await response.json();
    const { commit, os, cpu, memoryGb, node } = proof.environment;
    const day = proof.startedAt.slice(0, 10);
    source.textContent = `These numbers come from one laptop, not from this server: ${cpu}, ${memoryGb} GB, ${os}, Node ${node}, on ${day}, at commit ${commit ?? 'unknown'}. Only the buttons above are measured here. "Not run" means this report didn't cover it: some claims need a live model, or a command of their own.`;
    const rows = proof.claims.map(({ id, text, state }) => {
      const [label, kind] = STATES[state] ?? [state, 'other'];
      const row = make('tr');
      const claim = make('td');
      claim.append(make('span', 'claim-id', id), text);
      const outcome = make('td');
      outcome.append(make('span', `state ${kind}`, label));
      row.append(claim, outcome);
      return row;
    });
    table.tBodies[0].replaceChildren(...rows);
    table.hidden = false;
  } catch {
    source.textContent = "The last report couldn't be loaded.";
  }
}

void loadClaims();
