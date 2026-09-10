'use strict';

const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');

// Auto-reconnect backoff: 1s, 2s, 4s, ... capped at 30s, retried indefinitely.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// stderr output that means the forward is dead even if kubectl is still alive.
const LOST_CONNECTION_RE =
  /lost connection to pod|error forwarding port|connection refused|container not running/i;

/** Delay before reconnect attempt number `attempt` (0-based). */
function backoffDelay(attempt, baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS) {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

/**
 * Split a command string into argv tokens, honouring single and double quotes.
 * Good enough for kubectl port-forward commands (no shell expansion needed).
 */
function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Given the argv of a port-forward command, return the parsed local port
 * from the first port-mapping token, or null if it can only be known at
 * runtime (random port via ":REMOTE").
 */
function parseLocalPort(args) {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    let m = /^(\d+):(\d+)$/.exec(arg); // LOCAL:REMOTE
    if (m) return parseInt(m[1], 10);
    m = /^:(\d+)$/.exec(arg); // :REMOTE -> random local port
    if (m) return null;
    m = /^(\d+)$/.exec(arg); // bare REMOTE -> local == remote
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function schemeForPort(port) {
  return port === 443 || port === 8443 ? 'https' : 'http';
}

/**
 * Capture the user's login shell environment. When a GUI app is launched from
 * Finder/Dock (not a terminal) it does NOT inherit variables set in the shell
 * profile - most importantly KUBECONFIG - so kubectl would read the wrong
 * kubeconfig and fail with "context was not found". We run the login shell once
 * and read its environment. Returns {} on any failure (e.g. Windows).
 */
function loginShellEnv() {
  if (process.platform === 'win32') return {};
  const shell = process.env.SHELL || '/bin/zsh';
  const marker = '__K8ST_ENV_START__';
  try {
    // -i -l so both .zprofile/.zshrc (or .bash_profile/.bashrc) are sourced.
    // The marker lets us skip any prompt/banner noise printed before `env`.
    const out = execFileSync(shell, ['-ilc', `printf '%s\\n' ${marker}; env`], {
      timeout: 6000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const seg = out.slice(out.lastIndexOf(marker) + marker.length);
    const env = {};
    for (const line of seg.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    return env;
  } catch (_) {
    return {};
  }
}

/**
 * Build the environment for spawned kubectl processes: start from the login
 * shell env (for KUBECONFIG etc.), fall back to our own process env, and make
 * sure PATH covers the usual binary locations a GUI app would otherwise miss.
 */
function buildEnv() {
  const home = os.homedir();
  const shellEnv = loginShellEnv();
  const base = { ...process.env, ...shellEnv };
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/snap/bin', // Linux (snap-installed kubectl)
    path.join(home, '.local', 'bin'), // Linux user installs
    path.join(home, 'google-cloud-sdk', 'bin'),
  ];
  const current = (base.PATH || process.env.PATH || '').split(':');
  const seen = new Set();
  const merged = [...extra, ...current].filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  base.PATH = merged.join(':');
  return base;
}

/** Locate a usable kubectl binary. */
function resolveKubectl(env) {
  try {
    const out = execFileSync('/usr/bin/which', ['kubectl'], { env }).toString().trim();
    if (out) return out;
  } catch (_) {
    /* fall through to known locations */
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, 'google-cloud-sdk', 'bin', 'kubectl'),
    '/opt/homebrew/bin/kubectl',
    '/usr/local/bin/kubectl',
    '/usr/bin/kubectl',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* ignore */
    }
  }
  return 'kubectl';
}

class ConnectionManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {{get: Function, set: Function}} [options.store] persistence backend
   *   (defaults to electron-store; tests inject an in-memory object)
   * @param {object} [options.env] environment for spawned kubectl
   *   (defaults to the login-shell-derived env)
   * @param {string} [options.kubectlPath] kubectl binary to spawn
   * @param {number} [options.reconnectBaseMs] initial backoff delay
   * @param {number} [options.reconnectMaxMs] backoff cap
   */
  constructor(options = {}) {
    super();
    this.store =
      options.store ||
      new Store({
        name: 'connections',
        defaults: { connections: [] },
      });
    this.env = options.env || buildEnv();
    this.kubectlPath = options.kubectlPath || resolveKubectl(this.env);
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? RECONNECT_MAX_MS;
    // runtime state keyed by connection id
    this.runtime = new Map();
  }

  _runtimeFor(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, {
        status: 'stopped',
        pid: null,
        localPort: null,
        scheme: 'http',
        lastError: null,
        child: null,
        stopping: false,
        // Auto-reconnect state: `desired` is true while the user wants the
        // forward up; `attempt` counts consecutive failed (re)connects and
        // drives the backoff; `retryTimer` is the pending reconnect timeout.
        desired: false,
        attempt: 0,
        retryTimer: null,
        lostConnection: false,
      });
    }
    return this.runtime.get(id);
  }

  _persisted() {
    return this.store.get('connections', []);
  }

  /** Public snapshot of a connection combining persisted + runtime state. */
  _snapshot(conn) {
    const rt = this._runtimeFor(conn.id);
    return {
      id: conn.id,
      name: conn.name,
      command: conn.command,
      status: rt.status,
      pid: rt.pid,
      localPort: rt.localPort,
      scheme: rt.scheme,
      url: rt.localPort ? `${rt.scheme}://localhost:${rt.localPort}` : null,
      lastError: rt.lastError,
      attempt: rt.attempt,
    };
  }

  list() {
    return this._persisted().map((c) => this._snapshot(c));
  }

  get(id) {
    const conn = this._persisted().find((c) => c.id === id);
    return conn ? this._snapshot(conn) : null;
  }

  add({ name, command }) {
    const conn = {
      id: crypto.randomUUID(),
      name: (name || '').trim() || 'Untitled',
      command: (command || '').trim(),
    };
    const all = this._persisted();
    all.push(conn);
    this.store.set('connections', all);
    this._emitStatus(conn.id);
    return this._snapshot(conn);
  }

  update(id, { name, command }) {
    const all = this._persisted();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    if (typeof name === 'string') all[idx].name = name.trim() || 'Untitled';
    if (typeof command === 'string') all[idx].command = command.trim();
    this.store.set('connections', all);
    this._emitStatus(id);
    return this._snapshot(all[idx]);
  }

  remove(id) {
    this.stop(id);
    const all = this._persisted().filter((c) => c.id !== id);
    this.store.set('connections', all);
    this.runtime.delete(id);
    return true;
  }

  _clearRetry(rt) {
    if (rt.retryTimer) {
      clearTimeout(rt.retryTimer);
      rt.retryTimer = null;
    }
  }

  _emitStatus(id) {
    const snap = this.get(id);
    if (snap) this.emit('status', snap);
  }

  /**
   * Turn a stored command into kubectl argv, or return an error string when
   * the command is not a port-forward.
   */
  _argsFor(conn) {
    let args = tokenize(conn.command);
    if (args.length && /kubectl$/.test(args[0])) {
      args = args.slice(1); // strip leading "kubectl"
    }
    if (args.length === 0 || !args.includes('port-forward')) {
      return { error: 'Command must be a "kubectl port-forward ..." command.' };
    }
    return { args };
  }

  /** User intent: bring the forward up and keep it up until stop() is called. */
  start(id) {
    const conn = this._persisted().find((c) => c.id === id);
    if (!conn) return null;
    const rt = this._runtimeFor(id);
    if (rt.child) return this._snapshot(conn); // already running

    const { args, error } = this._argsFor(conn);
    if (error) {
      rt.status = 'error';
      rt.lastError = error;
      rt.desired = false;
      this._emitStatus(id);
      return this._snapshot(conn);
    }

    this._clearRetry(rt);
    rt.desired = true;
    rt.attempt = 0;
    rt.stopping = false;
    rt.lastError = null;
    const parsedPort = parseLocalPort(args);
    rt.localPort = parsedPort;
    rt.scheme = parsedPort ? schemeForPort(parsedPort) : 'http';

    this._spawn(id);
    return this._snapshot(conn);
  }

  /**
   * Schedule a respawn after an unexpected failure. Exponential backoff
   * (1s, 2s, 4s, ... capped at 30s), retried indefinitely while desired.
   */
  _scheduleReconnect(id, reason) {
    const rt = this._runtimeFor(id);
    this._clearRetry(rt);
    const delay = backoffDelay(rt.attempt, this.reconnectBaseMs, this.reconnectMaxMs);
    rt.attempt += 1;
    rt.status = 'reconnecting';
    rt.lastError = reason || null;
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      if (!rt.desired || rt.child) return;
      this._spawn(id);
    }, delay);
    this._emitStatus(id);
  }

  /** Spawn kubectl for a connection and wire up status tracking. */
  _spawn(id) {
    const conn = this._persisted().find((c) => c.id === id);
    if (!conn) return;
    const rt = this._runtimeFor(id);
    if (rt.child) return;

    const { args, error } = this._argsFor(conn);
    if (error) {
      // Command was edited into something invalid while we were reconnecting.
      rt.status = 'error';
      rt.lastError = error;
      rt.desired = false;
      this._emitStatus(id);
      return;
    }

    rt.stopping = false;
    rt.lostConnection = false;
    rt.status = 'starting';
    this._emitStatus(id);

    let child;
    try {
      child = spawn(this.kubectlPath, args, {
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      rt.status = 'error';
      rt.lastError = err.message;
      rt.child = null;
      rt.desired = false;
      this._emitStatus(id);
      return;
    }

    rt.child = child;
    rt.pid = child.pid;

    const handleLine = (line) => {
      const m = /Forwarding from (?:127\.0\.0\.1|\[::1\]|localhost):(\d+)/i.exec(line);
      if (m) {
        rt.localPort = parseInt(m[1], 10);
        rt.scheme = schemeForPort(rt.localPort);
        rt.attempt = 0; // healthy again: reset backoff
        rt.lastError = null;
        if (rt.status !== 'running') {
          rt.status = 'running';
        }
        this._emitStatus(id);
      }
    };

    child.stdout.on('data', (buf) => {
      buf
        .toString()
        .split('\n')
        .forEach((l) => l.trim() && handleLine(l));
    });

    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      text
        .split('\n')
        .forEach((l) => l.trim() && handleLine(l));
      // kubectl reports failures on stderr
      if (/error|unable|forbidden|not found|refused/i.test(text)) {
        rt.lastError = text.trim().split('\n').slice(-1)[0];
        this._emitStatus(id);
      }
      // Some kubectl versions keep running after the pod is gone but every
      // forwarded connection fails. Kill the child; the close handler then
      // schedules a reconnect. Only do this once per child.
      if (
        rt.desired &&
        !rt.stopping &&
        !rt.lostConnection &&
        LOST_CONNECTION_RE.test(text)
      ) {
        rt.lostConnection = true;
        try {
          child.kill('SIGTERM');
        } catch (_) {
          /* ignore */
        }
      }
    });

    child.on('error', (err) => {
      // e.g. kubectl binary missing: not something a retry will fix.
      rt.status = 'error';
      rt.lastError = err.message;
      rt.child = null;
      rt.pid = null;
      rt.desired = false;
      this._emitStatus(id);
    });

    child.on('close', (code) => {
      if (rt.child !== child) return; // stale handler (already replaced)
      rt.child = null;
      rt.pid = null;
      if (rt.stopping) {
        rt.status = 'stopped';
        rt.lastError = null;
        rt.stopping = false;
        this._emitStatus(id);
        return;
      }
      if (rt.desired) {
        const reason =
          rt.lastError ||
          (code && code !== 0
            ? `kubectl exited with code ${code}`
            : 'kubectl exited unexpectedly');
        this._scheduleReconnect(id, reason);
        return;
      }
      if (code && code !== 0) {
        rt.status = 'error';
        if (!rt.lastError) rt.lastError = `kubectl exited with code ${code}`;
      } else {
        rt.status = 'stopped';
      }
      this._emitStatus(id);
    });
  }

  stop(id) {
    const rt = this.runtime.get(id);
    if (!rt) return this.get(id);
    rt.desired = false;
    this._clearRetry(rt);
    if (!rt.child) {
      // Nothing running (possibly waiting on a reconnect timer).
      if (rt.status !== 'stopped') {
        rt.status = 'stopped';
        rt.lastError = null;
        this._emitStatus(id);
      }
      return this.get(id);
    }
    rt.stopping = true;
    rt.status = 'stopped';
    try {
      rt.child.kill('SIGTERM');
      // Escalate if it refuses to die.
      const child = rt.child;
      setTimeout(() => {
        if (child && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch (_) {
            /* ignore */
          }
        }
      }, 2000);
    } catch (_) {
      /* ignore */
    }
    this._emitStatus(id);
    return this.get(id);
  }

  stopAll() {
    for (const id of this.runtime.keys()) {
      const rt = this.runtime.get(id);
      if (!rt) continue;
      rt.desired = false;
      this._clearRetry(rt);
      if (!rt.child) {
        // Waiting on a reconnect timer: nothing to kill, just settle status.
        if (rt.status !== 'stopped' && rt.status !== 'error') {
          rt.status = 'stopped';
          rt.lastError = null;
          this._emitStatus(id);
        }
      } else {
        rt.stopping = true;
        try {
          rt.child.kill('SIGTERM');
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  urlFor(id) {
    const snap = this.get(id);
    return snap ? snap.url : null;
  }
}

module.exports = {
  ConnectionManager,
  tokenize,
  parseLocalPort,
  backoffDelay,
  LOST_CONNECTION_RE,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
};
