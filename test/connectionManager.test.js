'use strict';

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  backoffDelay,
  LOST_CONNECTION_RE,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} = require('../src/connectionManager');
const {
  fakeKubectlDir,
  makeManager,
  waitForStatus,
  wait,
} = require('./helpers/fakeKubectl');

describe('backoffDelay', () => {
  test('doubles from the base and caps at the max', () => {
    assert.equal(backoffDelay(0), 1000);
    assert.equal(backoffDelay(1), 2000);
    assert.equal(backoffDelay(2), 4000);
    assert.equal(backoffDelay(3), 8000);
    assert.equal(backoffDelay(4), 16000);
    assert.equal(backoffDelay(5), 30000);
    assert.equal(backoffDelay(50), 30000);
  });

  test('defaults match the exported constants', () => {
    assert.equal(backoffDelay(0), RECONNECT_BASE_MS);
    assert.equal(backoffDelay(100), RECONNECT_MAX_MS);
  });

  test('honours custom base and cap', () => {
    assert.equal(backoffDelay(0, 100, 400), 100);
    assert.equal(backoffDelay(2, 100, 400), 400);
    assert.equal(backoffDelay(3, 100, 400), 400);
  });
});

describe('LOST_CONNECTION_RE', () => {
  test('matches kubectl failure output', () => {
    assert.ok(LOST_CONNECTION_RE.test('E0101 portforward.go:400] error: lost connection to pod'));
    assert.ok(LOST_CONNECTION_RE.test('E0101 an error occurred forwarding 8080 -> 80: error forwarding port 80 to pod abc'));
    assert.ok(LOST_CONNECTION_RE.test('dial tcp 10.0.0.1:80: connect: connection refused'));
    assert.ok(LOST_CONNECTION_RE.test('container not running (app)'));
  });

  test('does not match normal output', () => {
    assert.ok(!LOST_CONNECTION_RE.test('Forwarding from 127.0.0.1:8080 -> 80'));
    assert.ok(!LOST_CONNECTION_RE.test('Handling connection for 8080'));
  });
});

describe('ConnectionManager', () => {
  let fake;
  const managers = [];

  before(() => {
    fake = fakeKubectlDir();
  });

  afterEach(() => {
    // Make sure no fake kubectl / timers survive between tests.
    for (const m of managers.splice(0)) m.stopAll();
    fake.resetRuns();
  });

  after(() => {
    fake.cleanup();
  });

  function manager(bin, overrides) {
    const m = makeManager(bin, overrides);
    managers.push(m);
    return m;
  }

  describe('CRUD', () => {
    test('add/list/get/update/remove persist to the store', () => {
      const mgr = manager(fake.healthy());
      const a = mgr.add({ name: '  A  ', command: ' kubectl port-forward svc/a 8080:80 ' });
      assert.equal(a.name, 'A');
      assert.equal(a.command, 'kubectl port-forward svc/a 8080:80');
      assert.equal(a.status, 'stopped');
      assert.equal(a.url, null);

      const b = mgr.add({ name: '', command: 'kubectl port-forward svc/b 1:2' });
      assert.equal(b.name, 'Untitled');
      assert.equal(mgr.list().length, 2);

      const updated = mgr.update(a.id, { name: 'A2' });
      assert.equal(updated.name, 'A2');
      assert.equal(mgr.get(a.id).command, 'kubectl port-forward svc/a 8080:80');
      assert.equal(mgr.update('nope', { name: 'x' }), null);

      assert.equal(mgr.remove(a.id), true);
      assert.equal(mgr.get(a.id), null);
      assert.equal(mgr.list().length, 1);
    });

    test('start/stop of an unknown id are no-ops', () => {
      const mgr = manager(fake.healthy());
      assert.equal(mgr.start('missing'), null);
      assert.equal(mgr.stop('missing'), null);
    });
  });

  describe('lifecycle', () => {
    test('start -> starting -> running, then stop -> stopped', async () => {
      const mgr = manager(fake.healthy(8080));
      const statuses = [];
      const conn = mgr.add({ name: 'T', command: 'kubectl port-forward svc/app 8080:80' });
      mgr.on('status', (s) => s.id === conn.id && statuses.push(s.status));

      const snap = mgr.start(conn.id);
      assert.equal(snap.status, 'starting');
      assert.equal(snap.localPort, 8080, 'port parsed up-front from the command');
      assert.equal(snap.url, 'http://localhost:8080');
      assert.ok(snap.pid > 0);

      const running = await waitForStatus(mgr, conn.id, 'running');
      assert.equal(running.url, 'http://localhost:8080');
      assert.equal(running.attempt, 0);
      assert.equal(running.lastError, null);
      assert.equal(mgr.urlFor(conn.id), 'http://localhost:8080');

      // Idempotent: a second start does not spawn again.
      mgr.start(conn.id);
      await wait(50);
      assert.equal(fake.runs(), 1);

      const stopping = mgr.stop(conn.id);
      assert.equal(stopping.status, 'stopped', 'status flips immediately on stop');
      await wait(200); // let the child actually exit
      const stopped = mgr.get(conn.id);
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.pid, null);
      assert.equal(stopped.lastError, null);
      assert.deepEqual(statuses.slice(0, 2), ['starting', 'running']);
      assert.equal(statuses.at(-1), 'stopped');
      assert.ok(!statuses.includes('reconnecting'), 'a user stop must not reconnect');

      // Still stopped a little later: no reconnect sneaks in.
      await wait(300);
      assert.equal(mgr.get(conn.id).status, 'stopped');
      assert.equal(fake.runs(), 1);
    });

    test('random local port (:REMOTE) is picked up from kubectl output', async () => {
      const mgr = manager(fake.randomPort(54321));
      const conn = mgr.add({ name: 'R', command: 'kubectl port-forward svc/app :80' });
      const snap = mgr.start(conn.id);
      assert.equal(snap.localPort, null);
      assert.equal(snap.url, null);
      const running = await waitForStatus(mgr, conn.id, 'running');
      assert.equal(running.localPort, 54321);
      assert.equal(running.url, 'http://localhost:54321');
    });

    test('https scheme for 443 / 8443', async () => {
      const mgr = manager(fake.healthy(8443));
      const conn = mgr.add({ name: 'S', command: 'kubectl port-forward svc/app 8443:443' });
      mgr.start(conn.id);
      const running = await waitForStatus(mgr, conn.id, 'running');
      assert.equal(running.url, 'https://localhost:8443');
    });

    test('invalid command -> error, nothing spawned, no retry', async () => {
      const mgr = manager(fake.healthy());
      const conn = mgr.add({ name: 'Bad', command: 'kubectl get pods' });
      const snap = mgr.start(conn.id);
      assert.equal(snap.status, 'error');
      assert.match(snap.lastError, /port-forward/);
      await wait(250);
      assert.equal(fake.runs(), 0);
      assert.equal(mgr.get(conn.id).status, 'error');
    });

    test('missing kubectl binary -> error, no reconnect', async () => {
      const mgr = manager(path.join(fake.dir, 'does-not-exist'));
      const conn = mgr.add({ name: 'NoBin', command: 'kubectl port-forward svc/app 8080:80' });
      mgr.start(conn.id);
      const err = await waitForStatus(mgr, conn.id, 'error');
      assert.match(err.lastError, /ENOENT/);
      await wait(300);
      assert.equal(mgr.get(conn.id).status, 'error');
    });
  });

  describe('auto-reconnect', () => {
    test('reconnects after kubectl exits and resets the backoff counter', async () => {
      const mgr = manager(fake.diesOnce(9090));
      const conn = mgr.add({ name: 'Flaky', command: 'kubectl port-forward svc/app 9090:80' });
      const statuses = [];
      mgr.on('status', (s) => s.id === conn.id && statuses.push(s.status));

      mgr.start(conn.id);
      await waitForStatus(mgr, conn.id, 'running');
      const reconnecting = await waitForStatus(mgr, conn.id, 'reconnecting');
      assert.equal(reconnecting.attempt, 1);
      assert.match(reconnecting.lastError, /lost connection to pod/);
      assert.equal(reconnecting.localPort, 9090, 'port is kept while reconnecting');
      assert.equal(reconnecting.pid, null);

      const running = await waitForStatus(mgr, conn.id, 'running');
      assert.equal(running.attempt, 0, 'backoff resets once healthy');
      assert.equal(running.lastError, null);
      assert.equal(fake.runs(), 2);

      const i = statuses.indexOf('reconnecting');
      assert.ok(i > 0);
      assert.deepEqual(statuses.slice(i, i + 3), ['reconnecting', 'starting', 'running']);
    });

    test('kills a still-running kubectl that reports a lost connection, then reconnects', async () => {
      const mgr = manager(fake.hangsAfterLoss(9091));
      const conn = mgr.add({ name: 'Hang', command: 'kubectl port-forward svc/app 9091:80' });
      mgr.start(conn.id);
      await waitForStatus(mgr, conn.id, 'running');
      const reconnecting = await waitForStatus(mgr, conn.id, 'reconnecting');
      assert.match(reconnecting.lastError, /lost connection to pod/);
      await waitForStatus(mgr, conn.id, 'running');
      assert.equal(fake.runs(), 2);
    });

    test('keeps retrying with growing backoff while kubectl keeps failing', async () => {
      const mgr = manager(fake.alwaysFails(), { reconnectBaseMs: 50, reconnectMaxMs: 100 });
      const conn = mgr.add({ name: 'Down', command: 'kubectl port-forward svc/app 8080:80' });
      const attempts = [];
      mgr.on('status', (s) => {
        if (s.id === conn.id && s.status === 'reconnecting') attempts.push(s.attempt);
      });
      mgr.start(conn.id);
      await wait(700);
      const snap = mgr.get(conn.id);
      assert.ok(fake.runs() >= 3, `expected several spawns, got ${fake.runs()}`);
      assert.ok(['reconnecting', 'starting'].includes(snap.status));
      assert.match(snap.lastError, /does not exist/);
      // attempts strictly increase: 1, 2, 3, ...
      assert.deepEqual(attempts, attempts.map((_, i) => i + 1));
    });

    test('stop during backoff -> stopped, no further spawn', async () => {
      const mgr = manager(fake.diesOnce(9092), { reconnectBaseMs: 400, reconnectMaxMs: 400 });
      const conn = mgr.add({ name: 'F', command: 'kubectl port-forward svc/app 9092:80' });
      mgr.start(conn.id);
      await waitForStatus(mgr, conn.id, 'reconnecting');
      assert.equal(fake.runs(), 1);

      const stopped = mgr.stop(conn.id);
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.lastError, null);
      await wait(600); // longer than the pending backoff
      assert.equal(mgr.get(conn.id).status, 'stopped');
      assert.equal(fake.runs(), 1);
    });

    test('remove during backoff clears runtime, no further spawn', async () => {
      const mgr = manager(fake.diesOnce(9093), { reconnectBaseMs: 400, reconnectMaxMs: 400 });
      const conn = mgr.add({ name: 'F', command: 'kubectl port-forward svc/app 9093:80' });
      mgr.start(conn.id);
      await waitForStatus(mgr, conn.id, 'reconnecting');
      mgr.remove(conn.id);
      assert.equal(mgr.get(conn.id), null);
      assert.equal(mgr.runtime.has(conn.id), false);
      await wait(600);
      assert.equal(fake.runs(), 1);
    });

    test('start() while reconnecting respawns immediately and resets attempt', async () => {
      const mgr = manager(fake.diesOnce(9094), { reconnectBaseMs: 2000, reconnectMaxMs: 2000 });
      const conn = mgr.add({ name: 'F', command: 'kubectl port-forward svc/app 9094:80' });
      mgr.start(conn.id);
      const reconnecting = await waitForStatus(mgr, conn.id, 'reconnecting');
      assert.equal(reconnecting.attempt, 1);

      const snap = mgr.start(conn.id); // user-triggered retry, skips the 2s wait
      assert.equal(snap.status, 'starting');
      assert.equal(snap.attempt, 0);
      await waitForStatus(mgr, conn.id, 'running', 1000);
      assert.equal(fake.runs(), 2);
    });

    test('stopAll() cancels running forwards and pending reconnects', async () => {
      const mgr = manager(fake.diesOnce(9095), { reconnectBaseMs: 400, reconnectMaxMs: 400 });
      const a = mgr.add({ name: 'A', command: 'kubectl port-forward svc/a 9095:80' });
      mgr.start(a.id);
      await waitForStatus(mgr, a.id, 'reconnecting');
      const runsBefore = fake.runs();

      // The run counter is shared, so the fake is already past its "die once"
      // run: this second connection comes up and stays up.
      const b = mgr.add({ name: 'B', command: 'kubectl port-forward svc/b 9096:80' });
      mgr.start(b.id);
      await waitForStatus(mgr, b.id, 'running');

      mgr.stopAll();
      assert.equal(mgr.get(a.id).status, 'stopped', 'pending reconnect is cancelled');
      await wait(600); // past the backoff, and time for b's child to exit
      assert.equal(mgr.get(a.id).status, 'stopped');
      assert.equal(mgr.get(b.id).status, 'stopped');
      assert.equal(mgr.get(b.id).pid, null);
      assert.equal(fake.runs(), runsBefore + 1, 'no reconnect spawned after stopAll');
    });

    test('command edited to something invalid while reconnecting -> error on next attempt', async () => {
      const mgr = manager(fake.diesOnce(9097), { reconnectBaseMs: 100, reconnectMaxMs: 100 });
      const conn = mgr.add({ name: 'F', command: 'kubectl port-forward svc/app 9097:80' });
      mgr.start(conn.id);
      await waitForStatus(mgr, conn.id, 'reconnecting');
      mgr.update(conn.id, { command: 'kubectl get pods' });
      const err = await waitForStatus(mgr, conn.id, 'error');
      assert.match(err.lastError, /port-forward/);
      await wait(300);
      assert.equal(mgr.get(conn.id).status, 'error');
      assert.equal(fake.runs(), 1);
    });
  });
});
