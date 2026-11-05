import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadAppCsv } from '../lib/appCsv.js';
import { normaliseSoapCsv } from '../lib/soapCsvSchema.js';
import { soapUiProjectToCsv } from '../lib/soapUiProject.js';

const project = (step) => `<con:soapui-project xmlns:con="x"><con:interface><con:operation id="1" action="urn:run" name="run"/></con:interface>
<con:testSuite><con:testCase>${step}</con:testCase></con:testSuite></con:soapui-project>`;

const step = (name, extra = '') => `<con:testStep type="request" name="${name}"${extra}><con:config><con:operation>run</con:operation>
<con:request name="${name}"><con:endpoint>https://h/svc?a=1&amp;b=2</con:endpoint><con:request><![CDATA[<E><publicName>${name}</publicName><in><![CDATA[<P/>]]]]>><![CDATA[</in></E>]]></con:request></con:request></con:config></con:testStep>`;

test('request steps become SOAP rows; nested CDATA is rejoined', () => {
  const out = soapUiProjectToCsv(project(step('SVC1')));
  assert.equal(out.ok, true);
  const n = normaliseSoapCsv(out.csv);
  assert.equal(n.ok, true);
  assert.deepEqual(n.apiNames, ['SVC1']);
  assert.match(n.csv, /https:\/\/h\/svc\?a=1&b=2/);
  assert.match(n.csv, /<in><!\[CDATA\[<P\/>\]\]><\/in>/);
  assert.match(n.csv, /urn:run/);
});

test('disabled steps are skipped; a project with no steps is rejected', () => {
  const out = soapUiProjectToCsv(project(step('A') + step('B', ' disabled="true"')));
  assert.equal(normaliseSoapCsv(out.csv).apiCount, 1);
  assert.equal(soapUiProjectToCsv(project('')).ok, false);
  assert.equal(soapUiProjectToCsv('<a/>').ok, false);
});

test('Route App SOAP loads from Route_SOAP_XML.xml only', async () => {
  const loaded = await loadAppCsv('Route App', 'SOAP');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fileName, 'Route_SOAP_XML.xml');
  const n = normaliseSoapCsv(loaded.buffer.toString('utf8'));
  assert.equal(n.ok, true);
  assert.ok(n.apiCount > 0);
  for (const name of ['X10CDISTRO', 'X10CONHNDU']) assert.ok(n.apiNames.includes(name), name);
  assert.ok(!n.apiNames.includes('X10CBUYBAC'));
  assert.ok(!n.apiNames.includes('X10CTRANSO'));
  assert.deepEqual(n.skipped, []);
});

test('Merchandiser App SOAP loads from Merchandiser_SOAP_XML.xml only', async () => {
  const loaded = await loadAppCsv('Merchandiser App', 'SOAP');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fileName, 'Merchandiser_SOAP_XML.xml');
  const n = normaliseSoapCsv(loaded.buffer.toString('utf8'));
  assert.equal(n.ok, true);
  assert.equal(n.apiCount, 20);
  assert.deepEqual(n.skipped, []);
});
