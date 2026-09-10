'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { trayState } = require('../src/trayState');

describe('trayState', () => {
  test('idle when there are no connections', () => {
    assert.equal(trayState([]), 'idle');
  });

  test('idle when nothing is running', () => {
    assert.equal(trayState(['stopped', 'error', 'stopped']), 'idle');
  });

  test('active when at least one is running', () => {
    assert.equal(trayState(['stopped', 'running']), 'active');
  });

  test('connecting while starting', () => {
    assert.equal(trayState(['starting']), 'connecting');
  });

  test('connecting while reconnecting', () => {
    assert.equal(trayState(['reconnecting']), 'connecting');
  });

  test('connecting takes precedence over running', () => {
    assert.equal(trayState(['running', 'reconnecting', 'running']), 'connecting');
    assert.equal(trayState(['running', 'starting']), 'connecting');
  });

  test('ignores unknown statuses', () => {
    assert.equal(trayState(['bogus']), 'idle');
    assert.equal(trayState(['bogus', 'running']), 'active');
  });
});
