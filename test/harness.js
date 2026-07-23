'use strict';

// Headless Electron harness that exercises ConnectionManager's full lifecycle
// (add -> start -> running -> openBrowser url -> stop) using a fake kubectl.
// Run with: npx electron test/harness.js

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ConnectionManager } = require('../src/connectionManager');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Fake kubectl that behaves like `port-forward`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakekube-'));
  const fake = path.join(dir, 'kubectl');
  fs.writeFileSync(
    fake,
    '#!/bin/sh\necho "Forwarding from 127.0.0.1:8080 -> 80"\nsleep 30\n'
  );
  fs.chmodSync(fake, 0o755);

  // Isolate the store so we do not touch real data.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'k8st-')));

  const mgr = new ConnectionManager();
  mgr.kubectlPath = fake; // force the fake binary

  const events = [];
  mgr.on('status', (s) => events.push(`${s.name}:${s.status}${s.url ? ' ' + s.url : ''}`));

  const conn = mgr.add({
    name: 'Test',
    command: 'kubectl port-forward -n ns svc/app 8080:80',
  });
  console.log('added:', conn.id, conn.status);

  mgr.start(conn.id);
  await wait(1500);
  let snap = mgr.get(conn.id);
  console.log('after start:', snap.status, 'url=', snap.url);
  const ok1 = snap.status === 'running' && snap.url === 'http://localhost:8080';

  mgr.stop(conn.id);
  await wait(1500);
  snap = mgr.get(conn.id);
  console.log('after stop:', snap.status);
  const ok2 = snap.status === 'stopped';

  // Error path: bad command.
  const bad = mgr.add({ name: 'Bad', command: 'kubectl get pods' });
  mgr.start(bad.id);
  await wait(200);
  const badSnap = mgr.get(bad.id);
  console.log('bad command:', badSnap.status, '-', badSnap.lastError);
  const ok3 = badSnap.status === 'error';

  console.log('events:', events.join(' | '));
  console.log('RESULT:', ok1 && ok2 && ok3 ? 'PASS' : 'FAIL');
  mgr.stopAll();
  app.exit(ok1 && ok2 && ok3 ? 0 : 1);
}

app.whenReady().then(main);
