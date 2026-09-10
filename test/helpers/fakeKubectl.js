'use strict';

// Test helpers: fake `kubectl` shell scripts and a ConnectionManager factory
// that runs under plain Node (in-memory store, no login-shell probing).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConnectionManager } = require('../../src/connectionManager');

/** Minimal in-memory stand-in for electron-store. */
function memoryStore() {
  const data = { connections: [] };
  return {
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set: (key, value) => {
      data[key] = value;
    },
  };
}

/**
 * Create a temp dir holding fake kubectl scripts. Returns helpers to write
 * scripts and a cleanup function. Every script gets a `runs` counter file so
 * tests can assert how many times kubectl was spawned.
 */
function fakeKubectlDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k8st-test-'));
  const counter = path.join(dir, 'runs');

  const write = (name, body) => {
    const file = path.join(dir, name);
    const script = [
      '#!/bin/sh',
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > "${counter}"`,
      body,
      '',
    ].join('\n');
    fs.writeFileSync(file, script);
    fs.chmodSync(file, 0o755);
    return file;
  };

  return {
    dir,
    runs: () => {
      try {
        return parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0;
      } catch (_) {
        return 0;
      }
    },
    resetRuns: () => {
      try {
        fs.unlinkSync(counter);
      } catch (_) {
        /* ignore */
      }
    },

    /** Prints the Forwarding line and stays up. */
    healthy: (port = 8080) =>
      write(
        'kubectl-healthy',
        `echo "Forwarding from 127.0.0.1:${port} -> 80"\nexec sleep 30`
      ),

    /** Prints a Forwarding line for a random-looking port and stays up. */
    randomPort: (port = 54321) =>
      write(
        'kubectl-random',
        `echo "Forwarding from 127.0.0.1:${port} -> 80"\nexec sleep 30`
      ),

    /**
     * First run: forwards briefly, then dies with exit 1 (pod restart).
     * Later runs: forwards and stays up.
     */
    diesOnce: (port = 9090) =>
      write(
        'kubectl-dies-once',
        [
          `echo "Forwarding from 127.0.0.1:${port} -> 80"`,
          'if [ "$n" = "0" ]; then',
          '  sleep 0.2',
          '  echo "error: lost connection to pod" >&2',
          '  exit 1',
          'fi',
          'exec sleep 30',
        ].join('\n')
      ),

    /**
     * First run: forwards, then reports a lost connection on stderr but keeps
     * running (old kubectl behaviour). Later runs: healthy.
     */
    hangsAfterLoss: (port = 9091) =>
      write(
        'kubectl-hangs',
        [
          `echo "Forwarding from 127.0.0.1:${port} -> 80"`,
          'if [ "$n" = "0" ]; then',
          '  sleep 0.2',
          '  echo "E0101 00:00:00 portforward.go:400] error: lost connection to pod" >&2',
          'fi',
          'exec sleep 30',
        ].join('\n')
      ),

    /** Always fails immediately (e.g. bad context). */
    alwaysFails: () =>
      write(
        'kubectl-fails',
        'echo "error: context \\"nope\\" does not exist" >&2\nexit 1'
      ),

    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Build a ConnectionManager wired to the fake binary. Backoff is shortened so
 * reconnect tests do not have to wait multiple seconds.
 */
function makeManager(kubectlPath, overrides = {}) {
  return new ConnectionManager({
    store: memoryStore(),
    env: { PATH: '/usr/bin:/bin' },
    kubectlPath,
    reconnectBaseMs: 100,
    reconnectMaxMs: 400,
    ...overrides,
  });
}

/** Resolve when the connection reaches `status` (or reject after timeout). */
function waitForStatus(mgr, id, status, timeoutMs = 5000) {
  const current = mgr.get(id);
  if (current && current.status === status) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mgr.off('status', onStatus);
      const now = mgr.get(id);
      reject(
        new Error(
          `timed out waiting for "${status}" (current: ${now ? now.status : 'missing'})`
        )
      );
    }, timeoutMs);
    function onStatus(snap) {
      if (snap.id === id && snap.status === status) {
        clearTimeout(timer);
        mgr.off('status', onStatus);
        resolve(snap);
      }
    }
    mgr.on('status', onStatus);
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { memoryStore, fakeKubectlDir, makeManager, waitForStatus, wait };
