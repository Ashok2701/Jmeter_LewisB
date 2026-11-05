import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCsv, serialiseCsv, normaliseHeader } from '../lib/csvSchema.js';
import { normaliseSoapCsv } from '../lib/soapCsvSchema.js';
import { parseInputParameters, buildParamXml, compareInputs } from '../lib/soapInputs.js';

const CSV = 'csv files/Route_SOAP_APIs.csv';
const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const header = rows[0];
const col = (n) => header.map(normaliseHeader).indexOf(n);
const dataRows = rows.slice(1);

// The request that would actually be sent for one source row.
function generated(row) {
  const out = normaliseSoapCsv(serialiseCsv([header, row]));
  assert.ok(out.ok, out.message);
  return parseCsv(out.csv)[1][4];
}

// Rows whose own REQUEST_XML disagrees with INPUT_PARAMETERS in the CSV itself.
// Each is reported to the CSV owner rather than rewritten here; this list must
// shrink as the CSV is corrected (the last test fails when an entry is stale).
const KNOWN_CSV_DISCREPANCIES = new Set([
  'X10CVALSDH', // REQUEST_XML field named I_I_XX10CLAT; INPUT_PARAMETERS says I_XX10CLAT
  'XINFORLVS#6', // 2nd line item and I_XVEHSTATUS missing from REQUEST_XML
  'X10CINUPOF', // inputs are scalars; REQUEST_XML wraps them in a table row
  'X10CONHNDU', // inputs are scalars; REQUEST_XML wraps them in a table row
  'X10CPAY', // I_XVR differs (…0035 vs …00356); I_XSIHNUM(0) missing from REQUEST_XML
  'X10CCNFDEP#34', // I_XUSRID missing from REQUEST_XML
]);
const keyOf = (r) => {
  const name = r[col('publicname')].trim();
  const no = r[col('serviceno')].trim();
  return ['XINFORLVS', 'X10CCNFDEP'].includes(name) ? `${name}#${no}` : name;
};

test('XX10CDCSAD: CSV inputs land in the inputXml PARAM payload', () => {
  const row = dataRows.find((r) => r[col('publicname')].trim() === 'XX10CDCSAD');
  const cdata = /<inputXml[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/inputXml>/.exec(generated(row))[1];
  assert.match(cdata, /^<PARAM>/); // Sage rejects whitespace before the first tag
  assert.match(cdata, /<FLD NAME="I_TYP" TYPE="Integer">0<\/FLD>/);
  assert.match(cdata, /<FLD NAME="I_BPR" TYPE="Char">B300<\/FLD>/);
  assert.match(cdata, /<FLD NAME="I_SREP" TYPE="Char">BU10<\/FLD>/);
  assert.deepEqual(compareInputs(generated(row), row[col('inputparameters')]), []);
});

test('envelope parts other than PARAM are untouched', () => {
  const row = dataRows.find((r) => r[col('publicname')].trim() === 'XX10CDCSAD');
  const before = row[col('requestxml')].replace(/<!\[CDATA\[[\s\S]*?\]\]>/, '');
  assert.equal(generated(row).replace(/<!\[CDATA\[[\s\S]*?\]\]>/, ''), before);
});

test('every row: each INPUT_PARAMETERS field is in the generated request with its value', () => {
  assert.equal(dataRows.length, 46);
  for (const row of dataRows) {
    const key = keyOf(row);
    if (KNOWN_CSV_DISCREPANCIES.has(key)) continue;
    const problems = compareInputs(generated(row), row[col('inputparameters')]);
    assert.deepEqual(problems, [], `${key}: ${JSON.stringify(problems)}`);
  }
});

test('known CSV discrepancies are real (remove an entry once its CSV row is fixed)', () => {
  const seen = new Set();
  for (const row of dataRows) {
    if (compareInputs(generated(row), row[col('inputparameters')]).length) seen.add(keyOf(row));
  }
  assert.deepEqual([...seen].sort(), [...KNOWN_CSV_DISCREPANCIES].sort());
});

test('a populated PARAM is never rewritten', () => {
  const row = dataRows.find((r) => r[col('publicname')].trim() === 'X10CPAY');
  const sent = generated(row);
  assert.match(sent, /VR-209-260817-00356/); // CSV's own value, not INPUT_PARAMETERS'
});

test('parser: formats used across the CSVs', () => {
  const { entries, unparsed } = parseInputParameters(
    [
      '"I_TYP" = 0',
      '"I_SREP"= BU10',
      "I_XDRIVERLID = '039902'",
      'I_XFCY  = "102"',
      'I_XDATE',
      'I_XITMREF(0) = "4601876"',
      'I_XQTY(0) = 5.00',
      'I_XBPC : 02090215',
      'I_XDATE2=[19/05/2026]',
      'I_XDT=date$',
      '"XUNAME" [TYPE=Char] = 020247',
      '',
    ].join('\n'),
  );
  assert.deepEqual(unparsed, []);
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(by.I_TYP.value, '0');
  assert.equal(by.I_SREP.value, 'BU10');
  assert.equal(by.I_XDRIVERLID.value, '039902');
  assert.equal(by.I_XFCY.value, '102');
  assert.equal(by.I_XDATE.kind, 'unassigned');
  assert.equal(by.I_XITMREF.index, 0);
  assert.equal(by.I_XQTY.value, '5.00');
  assert.equal(by.I_XBPC.value, '02090215');
  assert.equal(by.I_XDATE2.value, '19/05/2026');
  assert.equal(by.I_XDT.value, 'date$');
  assert.equal(by.XUNAME.type, 'Char');
});

test('buildParamXml: types, indexed rows, empty values, escaping', () => {
  const { entries } = parseInputParameters(
    ['A="x & <y>"', 'B=5', 'C=5.5', 'D', 'E=[11/07/2022]', 'T(0)="a"', 'Q(0)=1.00', 'T(1)="b"', 'Q(1)=2.00'].join('\n'),
  );
  const xml = buildParamXml(entries);
  assert.match(xml, /<FLD NAME="A" TYPE="Char">x &amp; &lt;y&gt;<\/FLD>/);
  assert.match(xml, /<FLD NAME="B" TYPE="Integer">5<\/FLD>/);
  assert.match(xml, /<FLD NAME="C" TYPE="Decimal">5.5<\/FLD>/);
  assert.match(xml, /<FLD NAME="D" TYPE="Char"><\/FLD>/);
  assert.match(xml, /<FLD NAME="E" TYPE="Date">11\/07\/2022<\/FLD>/);
  assert.match(xml, /<TAB DIM="999" ID="GRP2" SIZE="2">/);
  assert.match(xml, /<LIN NUM="2">\s*<FLD NAME="T" TYPE="Char">b<\/FLD>\s*<FLD NAME="Q" TYPE="Decimal">2.00<\/FLD>/);
});

test('buildParamXml: table-only inputs use GRP1; occurrence notation becomes LINs', () => {
  const { entries } = parseInputParameters(
    ['"F" [TYPE=Char] = a', '"G" [TYPE=Integer] = 1', '"F (occurrence 2)" [TYPE=Char] = b', '"G (occurrence 2)" [TYPE=Integer] = 2'].join('\n'),
  );
  const xml = buildParamXml(entries);
  assert.match(xml, /<TAB DIM="999" ID="GRP1" SIZE="2">/);
  assert.match(xml, /<LIN NUM="1">\s*<FLD NAME="F" TYPE="Char">a<\/FLD>\s*<FLD NAME="G" TYPE="Integer">1<\/FLD>\s*<\/LIN>/);
  assert.match(xml, /<LIN NUM="2">\s*<FLD NAME="F" TYPE="Char">b<\/FLD>\s*<FLD NAME="G" TYPE="Integer">2<\/FLD>\s*<\/LIN>/);
});

test('types declared in EXPECTED_RESPONSE win over inference', () => {
  const { entries } = parseInputParameters('I_X = 7');
  const xml = buildParamXml(entries, '<RESULT><GRP ID="GRP1"><FLD NAME="I_X" TYPE="Char">7</FLD></GRP></RESULT>');
  assert.match(xml, /TYPE="Char">7</);
});
