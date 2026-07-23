'use strict';

(() => {
const api = window.api;

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const formEl = document.getElementById('form');
const formTitle = document.getElementById('formTitle');
const fName = document.getElementById('fName');
const fCommand = document.getElementById('fCommand');
const formError = document.getElementById('formError');

let connections = [];
let editingId = null;

// ---- SVG icon factory ----
const ICONS = {
  play:
    '<path d="M4 3.5v9l8-4.5-8-4.5z"/>',
  stop:
    '<rect x="4" y="4" width="8" height="8" rx="1.2"/>',
  browser:
    '<path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 1.2c.9 0 1.9 1.4 2.3 3.6H5.7C6.1 4.3 7.1 2.7 8 2.7zM5.4 7.5h5.2c.03.33.05.66.05 1s-.02.67-.05 1H5.4a9.8 9.8 0 010-2zm.3 3.2h4.6C9.9 11.9 8.9 13.3 8 13.3s-1.9-1.4-2.3-2.6zM4.2 8.5c0-.34.02-.67.05-1H2.9a5.3 5.3 0 000 2h1.35c-.03-.33-.05-.66-.05-1zm7.5-1c.03.33.05.66.05 1s-.02.67-.05 1h1.35a5.3 5.3 0 000-2h-1.35zm.86-1.2h-1.2c-.2-1.1-.6-2.05-1.12-2.74a5.34 5.34 0 012.32 2.74zM5.9 3.56C5.38 4.25 4.98 5.2 4.78 6.3h-1.2A5.34 5.34 0 015.9 3.56zm-2.32 6.14h1.2c.2 1.1.6 2.05 1.12 2.74A5.34 5.34 0 013.58 9.7zm6.52 2.74c.52-.69.92-1.64 1.12-2.74h1.2a5.34 5.34 0 01-2.32 2.74z"/>',
  edit:
    '<path d="M11.5 1.7l2.8 2.8-7.6 7.6-3 .2.2-3 7.6-7.6zM10.6 2.6l-.9.9 2.8 2.8.9-.9-2.8-2.8z"/>',
};

function svg(name) {
  return `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
}

function subtitleFor(conn) {
  if (conn.status === 'error' && conn.lastError) return conn.lastError;
  if (conn.status === 'running') {
    return conn.localPort
      ? `Running - localhost:${conn.localPort}`
      : 'Running';
  }
  if (conn.status === 'starting') return 'Starting...';
  if (conn.localPort) return `Port ${conn.localPort}`;
  return 'Stopped';
}

function render() {
  listEl.innerHTML = '';
  if (connections.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  for (const conn of connections) {
    const li = document.createElement('li');
    li.className = 'conn-item';

    const dot = document.createElement('span');
    dot.className = `status-dot ${conn.status}`;
    li.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'conn-info';
    const name = document.createElement('div');
    name.className = 'conn-name';
    name.textContent = conn.name;
    const sub = document.createElement('div');
    sub.className = 'conn-sub' + (conn.status === 'error' ? ' error' : '');
    sub.textContent = subtitleFor(conn);
    info.appendChild(name);
    info.appendChild(sub);
    li.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'conn-actions';

    const isRunning = conn.status === 'running' || conn.status === 'starting';

    // Play / Stop toggle
    const toggle = document.createElement('button');
    toggle.className = 'act-btn ' + (isRunning ? 'stop' : 'play');
    toggle.title = isRunning ? 'Stop' : 'Start';
    toggle.innerHTML = svg(isRunning ? 'stop' : 'play');
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      if (isRunning) {
        await api.stop(conn.id);
      } else {
        await api.start(conn.id);
      }
    });
    actions.appendChild(toggle);

    // Open in browser
    const browse = document.createElement('button');
    browse.className = 'act-btn';
    browse.title = 'Open in browser';
    browse.innerHTML = svg('browser');
    browse.disabled = conn.status !== 'running' || !conn.localPort;
    browse.addEventListener('click', () => api.openInBrowser(conn.id));
    actions.appendChild(browse);

    // Edit
    const edit = document.createElement('button');
    edit.className = 'act-btn';
    edit.title = 'Edit';
    edit.innerHTML = svg('edit');
    edit.addEventListener('click', () => openForm(conn));
    actions.appendChild(edit);

    li.appendChild(actions);
    listEl.appendChild(li);
  }
}

async function refresh() {
  connections = await api.list();
  render();
}

// ---- Form ----
function openForm(conn) {
  editingId = conn ? conn.id : null;
  formTitle.textContent = conn ? 'Edit connection' : 'New connection';
  fName.value = conn ? conn.name : '';
  fCommand.value = conn ? conn.command : '';
  formError.classList.add('hidden');
  formError.textContent = '';

  // Show delete button only when editing.
  document.getElementById('cancelBtn').textContent = 'Cancel';
  const existingDelete = document.getElementById('deleteBtn');
  if (existingDelete) existingDelete.remove();
  if (conn) {
    const del = document.createElement('button');
    del.id = 'deleteBtn';
    del.className = 'text-btn delete-link';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await api.remove(conn.id);
      closeForm();
      refresh();
    });
    document.querySelector('.form-actions').prepend(del);
  }

  formEl.classList.remove('hidden');
  fName.focus();
}

function closeForm() {
  formEl.classList.add('hidden');
  editingId = null;
}

async function save() {
  const name = fName.value.trim();
  const command = fCommand.value.trim();
  if (!name) {
    return showFormError('Please enter a name.');
  }
  if (!/port-forward/.test(command)) {
    return showFormError('Command must be a "kubectl port-forward ..." command.');
  }
  if (editingId) {
    await api.update(editingId, { name, command });
  } else {
    await api.add({ name, command });
  }
  closeForm();
  refresh();
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

// ---- Wire up ----
document.getElementById('addBtn').addEventListener('click', () => openForm(null));
document
  .getElementById('emptyAddBtn')
  .addEventListener('click', () => openForm(null));
document.getElementById('cancelBtn').addEventListener('click', closeForm);
document.getElementById('saveBtn').addEventListener('click', save);

// Live status updates from the main process.
api.onStatus((snapshot) => {
  const idx = connections.findIndex((c) => c.id === snapshot.id);
  if (idx === -1) {
    refresh();
  } else {
    connections[idx] = snapshot;
    render();
  }
});

refresh();
})();
