// Usage: node scripts/audit-soap-inputs.mjs "csv files/Route_SOAP_APIs.csv" [...more CSVs]
// For every row, checks that INPUT_PARAMETERS is reflected in the request that
// would actually be sent (REQUEST_XML after normaliseSoapCsv) and lists every
// disagreement. Exit code 1 when any row has one.
import fs from 'node:fs';
import { parseCsv, serialiseCsv, normaliseHeader } from '../lib/csvSchema.js';
import { normaliseSoapCsv } from '../lib/soapCsvSchema.js';
import { compareInputs, parseInputParameters } from '../lib/soapInputs.js';

let bad = 0;
for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = parseCsv(text);
  const col = (n) => rows[0].map(normaliseHeader).indexOf(n);
  const src = rows.slice(1).filter((r) => (r[col('publicname')] ?? '').trim() && (r[col('requestxml')] ?? '').trim());
  console.log(`\n${file}: ${src.length} rows`);
  src.forEach((r, i) => {
    const name = r[col('publicname')].trim();
    const input = r[col('inputparameters')] ?? '';
    const { unparsed } = parseInputParameters(input);
    // One row at a time, so a row the normaliser skips cannot shift the pairing.
    const one = normaliseSoapCsv(serialiseCsv([rows[0], r]));
    if (!one.ok) {
      console.log(`  #${r[col('serviceno')] ?? i + 1} ${name}: skipped by normaliser (${one.message})`);
      return;
    }
    const problems = compareInputs(parseCsv(one.csv)[1][4], input); // column 4 = RequestXml
    for (const u of unparsed) problems.push({ kind: 'unparsed', field: u, detail: 'INPUT_PARAMETERS line not understood' });
    if (!problems.length) return;
    bad++;
    console.log(`  #${r[col('serviceno')] ?? i + 1} ${name}`);
    for (const p of problems) console.log(`    [${p.kind}] ${p.field}: ${p.detail}`);
  });
}
console.log(bad ? `\n${bad} row(s) with input discrepancies.` : '\nAll rows consistent.');
process.exitCode = bad ? 1 : 0;
