import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { OUTPUT_DIR } from './config.js';

// Streaming the .jtl to tally response codes is cheap for a smoke test and
// expensive for a long load test, so it is only done for a file small enough
// to read quickly. The pass/fail counts never depend on it.
const MAX_JTL_SCAN_BYTES = 200 * 1024 * 1024;

/**
 * The test plan emits two samples per API row: a "Prepare - ..." JSR223 sampler
 * that makes no network call and effectively always passes, and the real HTTP
 * request. A run in which every API call fails therefore reports an overall
 * error rate of 50%, not 100% - which reads as "half my APIs worked" when in
 * fact none did. Splitting the two apart is what makes the number meaningful.
 */
function classify(label) {
  if (label === 'Total') return 'total';
  if (label.startsWith('Prepare - ')) return 'internal';
  if (label.endsWith('(SKIPPED)')) return 'skipped';
  return 'api';
}

async function tallyResponseCodes(jtlPath) {
  try {
    const stat = await fsp.stat(jtlPath);
    if (stat.size > MAX_JTL_SCAN_BYTES) return null;
  } catch {
    return null;
  }

  const counts = new Map();
  const stream = fs.createReadStream(jtlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let header = null;
  let codeIdx = -1;
  let messageIdx = -1;
  let successIdx = -1;
  let labelIdx = -1;

  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = line.split(',');
      codeIdx = header.indexOf('responseCode');
      messageIdx = header.indexOf('responseMessage');
      successIdx = header.indexOf('success');
      labelIdx = header.indexOf('label');
      if (successIdx === -1 || codeIdx === -1) break;
      continue;
    }

    // These leading columns hold no commas in JMeter's default CSV output, so a
    // plain split is safe for the fields read here.
    const parts = line.split(',');
    if (parts[successIdx] !== 'false') continue;
    if (classify(parts[labelIdx] ?? '') !== 'api') continue;

    const key = `${parts[codeIdx] ?? ''}|${parts[messageIdx] ?? ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  rl.close();

  return [...counts.entries()]
    .map(([key, count]) => {
      const [code, message] = key.split('|');
      return { code, message, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/**
 * Summarises a finished run from the dashboard's own statistics.json, so the UI
 * can say how many APIs actually passed rather than only that the .bat exited 0.
 */
export async function readRunSummary(outputFolderName) {
  if (!outputFolderName) return null;

  const runDir = path.join(OUTPUT_DIR, outputFolderName);
  const statsPath = path.join(runDir, 'dashboard', 'statistics.json');

  let stats;
  try {
    stats = JSON.parse(await fsp.readFile(statsPath, 'utf8'));
  } catch {
    return null;
  }

  let apiCalls = 0;
  let apiErrors = 0;
  let skipped = 0;
  const failingApis = [];

  for (const [label, row] of Object.entries(stats)) {
    const kind = classify(label);
    const sampleCount = Number(row?.sampleCount ?? 0);
    const errorCount = Number(row?.errorCount ?? 0);

    if (kind === 'skipped') {
      skipped += sampleCount;
      continue;
    }
    if (kind !== 'api') continue;

    apiCalls += sampleCount;
    apiErrors += errorCount;
    if (errorCount > 0) {
      failingApis.push({
        label,
        sampleCount,
        errorCount,
        errorPct: Number(row?.errorPct ?? 0),
      });
    }
  }

  const total = stats.Total ?? {};

  return {
    apiCalls,
    apiPassed: apiCalls - apiErrors,
    apiErrors,
    apiErrorPct: apiCalls ? Number(((apiErrors / apiCalls) * 100).toFixed(2)) : 0,
    skipped,
    // The dashboard's own headline figures. The report now filters the
    // internal Prepare samplers out (scripts\report-generator.properties), so
    // these match the API figures above for any run generated since; they are
    // still recorded because older runs in .runs\ carry the doubled numbers.
    overallSamples: Number(total.sampleCount ?? 0),
    overallErrorPct: Number(total.errorPct ?? 0),
    failingApis: failingApis
      .sort((a, b) => b.errorCount - a.errorCount)
      .slice(0, 5),
    topErrors: await tallyResponseCodes(path.join(runDir, 'results.jtl')),
  };
}
