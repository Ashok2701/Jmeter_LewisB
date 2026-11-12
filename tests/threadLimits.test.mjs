import test from 'node:test';
import assert from 'node:assert/strict';
import { maxThreadsFor, threadLimitMessage } from '../lib/applications.js';

test('thread caps per application and API type', () => {
  assert.equal(maxThreadsFor('Merchandiser App', 'REST'), 1300);
  assert.equal(maxThreadsFor('Merchandiser App', 'SOAP'), 1300);
  assert.equal(maxThreadsFor('Route App', 'REST'), 150);
  assert.equal(maxThreadsFor('Route App', 'SOAP'), 150);
  assert.equal(maxThreadsFor('Sales Order Adjustment Web App', 'REST'), 100);
  assert.equal(maxThreadsFor('Sales Order Adjustment Web App', 'SOAP'), 100);
  assert.equal(maxThreadsFor('Sales Order Adjustment Web App', 'SQL'), null);
});

test('threads over the cap are rejected, at or under are accepted', () => {
  assert.equal(threadLimitMessage('Route App', 'REST', '150'), null);
  assert.match(threadLimitMessage('Route App', 'REST', '151'), /cannot exceed 150/);
  assert.equal(threadLimitMessage('Merchandiser App', 'SOAP', 1300), null);
  assert.match(threadLimitMessage('Merchandiser App', 'REST', '1301'), /1,300/);
  assert.match(threadLimitMessage('Sales Order Adjustment Web App', 'SOAP', '101'), /cannot exceed 100/);
  assert.equal(threadLimitMessage('Sales Order Adjustment Web App', 'SQL', '5000'), null);
});
