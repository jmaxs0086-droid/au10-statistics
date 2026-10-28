#!/usr/bin/env node
'use strict';

// Regression tests for the bundled AU10 local decision core.
// Uses a fake WebView environment; does not access a betting site or submit orders.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const store = new Map();
const window = {
  localStorage: {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); }
  },
  document: {
    readyState: 'loading',
    addEventListener() {}
  },
  setInterval() { return 1; },
  Date,
  console
};
vm.runInNewContext(fs.readFileSync('ios-local-app/Web/local-brain.js', 'utf8'), { window, console, Date });
const brain = window.AU10LocalBrain;
assert.ok(brain, 'local brain exports its public API');

const history = [
  { issue: '202610280105', candidates: [1, 2, 3, 4, 5, 6], champion: 10, result: '未命中' },
  { issue: '202610280104', candidates: [1, 2, 3, 4, 5, 6], champion: 9, result: '未命中' },
  { issue: '202610280103', candidates: [1, 2, 3, 4, 5, 6], champion: 8, result: '未命中' },
  { issue: '202610280102', candidates: [1, 2, 3, 4, 5, 6], champion: 7, result: '未命中' },
  { issue: '202610280101', candidates: [1, 2, 3, 4, 5, 6], champion: 1, result: '命中' }
];
const queue = brain.buildMissQueue(history);
assert.equal(queue.length, 4, 'queue contains four unique miss tails');
assert.deepEqual(Array.from(queue), [2, 3, 4, 5], 'queue is ordered oldest to newest');
assert.deepEqual(Array.from(brain.setAmounts([10, 20, 30, 40])), [10, 20, 30, 40]);
assert.equal(brain.amount(), 10, 'first tier is selected initially');
assert.equal(brain.begin('202610280105', [1, 2, 3, 4, 5, 6]).ok, true, 'matching tail accepts six unique candidates');
assert.equal(brain.getState().pendingIssue, '202610280105');
assert.equal(brain.completeAction('202610280105', false), true, 'failed dry-run action can be cleared');
assert.equal(brain.getState().pendingIssue, '');
assert.equal(brain.begin('202610280105', [1, 1, 2, 3, 4, 5]).ok, false, 'duplicate candidates are rejected');
brain.setPaused(true);
assert.equal(brain.begin('202610280105', [1, 2, 3, 4, 5, 6]).ok, false, 'paused automation cannot begin');
console.log('PASS: local brain API, miss-tail queue, amount tiers, candidate validation, and pause guard');
