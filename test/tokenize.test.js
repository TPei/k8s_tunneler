'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, parseLocalPort } = require('../src/connectionManager');

describe('tokenize', () => {
  test('splits on whitespace', () => {
    assert.deepEqual(tokenize('kubectl port-forward svc/app 8080:80'), [
      'kubectl',
      'port-forward',
      'svc/app',
      '8080:80',
    ]);
  });

  test('collapses runs of whitespace and trims', () => {
    assert.deepEqual(tokenize('  a \t b\n c  '), ['a', 'b', 'c']);
  });

  test('honours double quotes', () => {
    assert.deepEqual(tokenize('--context "my cluster" pod/x'), [
      '--context',
      'my cluster',
      'pod/x',
    ]);
  });

  test('honours single quotes', () => {
    assert.deepEqual(tokenize("-n 'name space' svc/a"), ['-n', 'name space', 'svc/a']);
  });

  test('allows quotes glued to text and empty quoted strings', () => {
    assert.deepEqual(tokenize('--flag="a b" ""'), ['--flag=a b', '']);
  });

  test('returns [] for empty input', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('   '), []);
  });
});

describe('parseLocalPort', () => {
  test('LOCAL:REMOTE returns the local port', () => {
    assert.equal(parseLocalPort(['port-forward', 'svc/app', '8080:80']), 8080);
  });

  test(':REMOTE (random local port) returns null', () => {
    assert.equal(parseLocalPort(['port-forward', 'svc/app', ':80']), null);
  });

  test('bare REMOTE means local == remote', () => {
    assert.equal(parseLocalPort(['port-forward', 'svc/app', '443']), 443);
  });

  test('skips flags and their look-alikes', () => {
    assert.equal(
      parseLocalPort(['port-forward', '-n', 'ns', '--address=0.0.0.0', 'svc/app', '9090:80']),
      9090
    );
  });

  test('returns null when no port mapping is present', () => {
    assert.equal(parseLocalPort(['port-forward', 'svc/app']), null);
    assert.equal(parseLocalPort([]), null);
  });

  test('uses the first mapping when several are given', () => {
    assert.equal(parseLocalPort(['port-forward', 'svc/app', '8080:80', '9090:90']), 8080);
  });
});
