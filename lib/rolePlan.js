/**
 * Runs the Merchandiser REST test with its threads split between user types.
 *
 * Nothing about the API definitions, requests or authentication changes. A
 * split run is the SAME test plan (JMeter_API_Automation.jmx) with its one
 * Thread Group repeated once per user type that has threads:
 *
 *  - each group has that type's number of threads and the ONE overall ramp-up,
 *    so every type starts and runs concurrently;
 *  - each group reads only its own type's APIs (test-data-<type>.csv), and
 *    every thread reads that whole list itself ("Current thread" CSV sharing),
 *    so each thread executes all of its type's APIs;
 *  - threads are numbered 0, 1, 2... within their group, which is what
 *    scripts\PrepareRequest.groovy uses to pick the thread's own user code: the
 *    first thread of a type takes the first code of that type's sheet, the
 *    second thread the second code, and so on.
 *
 * The plan is generated per run from the real .jmx, so a later change to that
 * file is picked up automatically; the original file is never modified.
 */
import { normaliseHeader, parseCsv, serialiseCsv } from './csvSchema.js';
import { USER_TYPES, userTypeOfApiName } from './userTypes.js';

/**
 * Splits the (workbook-converted) API CSV text into one CSV per user type.
 * Returns { ok, byType: { key: { csv, apiNames, roleSlugs } } } or
 * { ok: false, message } when an API belongs to none of the user types.
 */
export function splitApiCsvByType(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: false, message: 'The API list has no rows.' };
  const header = rows[0];
  const nameCol = header.map(normaliseHeader).indexOf('apiname');
  const endpointCol = header.map(normaliseHeader).indexOf('endpoint');
  if (nameCol < 0) return { ok: false, message: 'The API list has no API_NAME column.' };

  const groups = new Map(USER_TYPES.map((t) => [t.key, []]));
  const unknown = [];
  for (const row of rows.slice(1)) {
    if (row.every((c) => String(c ?? '').trim() === '')) continue;
    const key = userTypeOfApiName(row[nameCol]);
    if (!key) unknown.push(row[nameCol] || '(no name)');
    else groups.get(key).push(row);
  }
  if (unknown.length) {
    const typeList = USER_TYPES.map((t) => `"${t.prefix} - ..."`).join(', ');
    return {
      ok: false,
      message:
        `${unknown.length} API(s) do not belong to a user type (API_NAME must start with ${typeList}): ` +
        `${unknown.slice(0, 3).join('; ')}${unknown.length > 3 ? '; ...' : ''}`,
    };
  }

  const byType = {};
  for (const [key, list] of groups) {
    const slugs = new Set();
    if (endpointCol >= 0) {
      for (const row of list) {
        for (const m of String(row[endpointCol] ?? '').matchAll(/\{USER_CODE:([a-z0-9_]+)\}/gi)) {
          slugs.add(m[1].toLowerCase());
        }
      }
    }
    byType[key] = {
      csv: serialiseCsv([header, ...list]),
      apiNames: list.map((r) => r[nameCol]),
      roleSlugs: [...slugs],
    };
  }
  return { ok: true, byType };
}

/**
 * Which user type and user code each JMeter thread of a run uses - the list the
 * Test Running popup shows. It applies the rule scripts\PrepareRequest.groovy
 * applies at run time (thread N of a group takes code N of the type's sheet,
 * in sheet order; wrapping round only when there are more threads than codes),
 * so what is listed is what the threads use. Nothing is random.
 *
 *   parts          splitApiCsvByType(...).byType
 *   split          [{ key, label, threads }] in test-plan order, or null for an
 *                  unsplit run, whose threads each run every user type's APIs
 *   totalThreads   the run's Total Threads (unsplit runs)
 *   codesByRole    Map role slug -> user codes in sheet order
 *
 * Returns [{ jmeterThread, label, userType, userCode, codes, apis }]:
 * `jmeterThread` is the thread's name in results.jtl, `userCode` the code shown
 * ('' for a type whose APIs use fixed values, e.g. Admin), `codes` the
 * [{ userType, userCode }] of an unsplit thread, `apis` how many APIs the thread
 * runs per loop (null when threads share the list).
 */
export function buildThreadPlan({ parts, split, totalThreads, codesByRole }) {
  const typeOf = new Map(USER_TYPES.map((t) => [t.key, t]));
  const codeFor = (key, index) => {
    const found = [];
    for (const slug of parts[key]?.roleSlugs ?? []) {
      const codes = codesByRole.get(slug) ?? [];
      if (codes.length) found.push(codes[index % codes.length]);
    }
    return found.join(', ');
  };

  const plan = [];
  if (split) {
    split.forEach((group, g) => {
      const type = typeOf.get(group.key);
      for (let i = 0; i < group.threads; i += 1) {
        plan.push({
          jmeterThread: `API Execution - ${group.label} ${g + 1}-${i + 1}`,
          label: `${type.reportLabel} ${i + 1}`,
          userType: type.reportLabel,
          userCode: codeFor(group.key, i),
          codes: null,
          apis: parts[group.key].apiNames.length,
        });
      }
    });
    return plan;
  }

  for (let i = 0; i < totalThreads; i += 1) {
    const codes = USER_TYPES.map((type) => ({ userType: type.reportLabel, userCode: codeFor(type.key, i) })).filter(
      (c) => c.userCode
    );
    plan.push({
      jmeterThread: `API Execution - Thread Group 1-${i + 1}`,
      label: `Thread ${i + 1}`,
      userType: 'All user types',
      userCode: codes.map((c) => `${c.userType}: ${c.userCode}`).join(' · '),
      codes,
      apis: null,
    });
  }
  return plan;
}

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Builds the multi-group test plan text from the base plan.
 * `groups` = [{ label, threads, rows, csvPath }] - one per user type with threads.
 */
export function buildRolesPlan(baseJmx, groups) {
  const footer = /(\r?\n)    <\/hashTree>(\r?\n)  <\/hashTree>(\r?\n)<\/jmeterTestPlan>\s*$/.exec(baseJmx);
  const start = baseJmx.indexOf('      <ThreadGroup ');
  if (!footer || start < 0 || start >= footer.index) {
    throw new Error('The test plan does not have the expected single Thread Group layout.');
  }
  const head = baseJmx.slice(0, start);
  let block = baseJmx.slice(start, footer.index);
  const tail = baseJmx.slice(footer.index);

  // The Results Writer lives inside the Thread Group; with several groups it
  // would be written once per group to the same file. It moves to plan level.
  const collector = /[ \t]*<ResultCollector [\s\S]*?<\/ResultCollector>\r?\n[ \t]*<hashTree\/>\r?\n/.exec(block);
  if (!collector) throw new Error('The test plan has no Results Writer to carry over.');
  block = block.replace(collector[0], '');

  const must = (text, find) => {
    if (!text.includes(find)) throw new Error(`The test plan no longer contains "${find}".`);
  };
  must(block, 'testname="API Execution - Thread Group"');
  must(block, '<stringProp name="ThreadGroup.num_threads">${__P(THREADS,1)}</stringProp>');
  must(block, '${__P(CSV_ROW_COUNT,14)}');
  must(block, '<stringProp name="filename">${__P(CSV_FILE,APIs.csv)}</stringProp>');
  must(block, '<stringProp name="shareMode">shareMode.all</stringProp>');

  const copies = groups.map((g) =>
    block
      .replace('testname="API Execution - Thread Group"', `testname="${escapeXml(`API Execution - ${g.label}`)}"`)
      .replace(
        '<stringProp name="ThreadGroup.num_threads">${__P(THREADS,1)}</stringProp>',
        `<stringProp name="ThreadGroup.num_threads">${Number(g.threads)}</stringProp>`
      )
      .replace('${__P(CSV_ROW_COUNT,14)}', String(Number(g.rows)))
      .replace(
        '<stringProp name="filename">${__P(CSV_FILE,APIs.csv)}</stringProp>',
        `<stringProp name="filename">${escapeXml(g.csvPath)}</stringProp>`
      )
      .replace(
        '<stringProp name="shareMode">shareMode.all</stringProp>',
        '<stringProp name="shareMode">shareMode.thread</stringProp>'
      )
  );

  const nl = footer[1];
  const writer = collector[0].replace(/\s+$/, '');
  return head + copies.join(nl) + nl + writer + tail;
}
