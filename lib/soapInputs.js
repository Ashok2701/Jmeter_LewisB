/**
 * SOAP INPUT_PARAMETERS handling.
 *
 * A SOAP CSV row carries its business inputs twice: as a human-written list in
 * INPUT_PARAMETERS ("I_TYP" = 0, I_XITMREF(0) = "4601876", ...) and as the
 * <PARAM> payload inside REQUEST_XML's inputXml CDATA. For most rows the two
 * agree; for some (e.g. XX10CDCSAD) the CSV author left <PARAM> empty, so Sage
 * X3 answers HTTP 200 and simply echoes empty inputs.
 *
 * This module builds the <PARAM> content from INPUT_PARAMETERS using the same
 * conventions the populated rows in the CSVs already follow:
 *   - a plain NAME is a scalar <FLD NAME TYPE> directly under <PARAM>;
 *   - NAME(i) fields are rows of one <TAB ID DIM SIZE> of <LIN NUM> blocks,
 *     NUM numbering the distinct indexes 1..n in ascending index order;
 *   - the TAB is GRP2 when scalars are present, otherwise GRP1 (Sage numbers
 *     the groups in order), DIM 999;
 *   - TYPE is the explicit `[TYPE=x]` when INPUT_PARAMETERS gives one, else the
 *     field's declaration in EXPECTED_RESPONSE when it is echoed there, else
 *     from the value: quoted -> Char, [dd/mm/yyyy] or
 *     date$ -> Date, bare integer -> Integer, bare decimal -> Decimal.
 *
 * REQUEST_XML that already carries parameters is never rewritten; compareInputs
 * reports where such a payload disagrees with INPUT_PARAMETERS instead.
 */

const LINE_RE = /^["']?([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*occurrence\s+(\d+)\s*\))?["']?\s*(?:\(\s*(\d+)\s*\))?\s*(?:\[\s*TYPE\s*=\s*(\w+)\s*\])?\s*(?:[=:]\s*(.*))?$/;

/**
 * Parses an INPUT_PARAMETERS cell into [{ name, index, value, quoted, assigned }].
 * Accepts `NAME = v`, `"NAME" = v`, `NAME(0) = v`, `NAME : v`, single or double
 * quoted values, and bare `NAME` (declared but unassigned). Lines it cannot
 * read are returned in `unparsed` rather than dropped silently.
 */
export function parseInputParameters(text) {
  const entries = [];
  const unparsed = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      unparsed.push(line);
      continue;
    }
    const [, name, occurrence, index, explicitType, rawValue] = m;
    const assigned = rawValue !== undefined;
    let value = (rawValue ?? '').trim();
    let kind = 'bare';
    const quote = value.length >= 2 && /^["']/.test(value) && value.endsWith(value[0]) ? value[0] : '';
    if (quote) {
      value = value.slice(1, -1);
      kind = 'quoted';
    } else if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).trim();
      kind = 'date';
    } else if (/^date\$$/i.test(value)) {
      kind = 'date';
    }
    entries.push({
      name,
      index: index !== undefined ? Number(index) : occurrence !== undefined ? Number(occurrence) - 1 : null,
      type: explicitType,
      raw: line,
      value,
      kind: assigned ? kind : 'unassigned',
    });
  }
  // "NAME (occurrence N)" repeats a record: the unsuffixed NAME is occurrence 1.
  const repeated = new Set(entries.filter((e) => e.index !== null && /\(\s*occurrence/i.test(e.raw)).map((e) => e.name));
  for (const e of entries) {
    if (e.index === null && repeated.has(e.name)) e.index = 0;
    delete e.raw;
  }
  return { entries, unparsed };
}

/** Field TYPEs declared in a result XML (EXPECTED_RESPONSE): { NAME: TYPE }. */
function declaredTypes(expectedResponse) {
  const types = {};
  const re = /<FLD\s+NAME="([^"]+)"\s+TYPE="([^"]+)"/g;
  let m;
  while ((m = re.exec(String(expectedResponse ?? '')))) types[m[1]] ??= m[2];
  return types;
}

function typeFor(entry, declared) {
  if (entry.type) return entry.type;
  if (declared[entry.name]) return declared[entry.name];
  if (entry.kind === 'date') return 'Date';
  if (entry.kind === 'bare') {
    if (/^[+-]?\d+$/.test(entry.value)) return 'Integer';
    if (/^[+-]?\d*\.\d+$/.test(entry.value)) return 'Decimal';
  }
  return 'Char';
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Builds the <PARAM>...</PARAM> text for parsed entries. */
export function buildParamXml(entries, expectedResponse = '') {
  const declared = declaredTypes(expectedResponse);
  const fld = (e, pad) =>
    `${pad}<FLD NAME="${e.name}" TYPE="${typeFor(e, declared)}">${escapeXml(e.value)}</FLD>`;

  const scalars = entries.filter((e) => e.index === null);
  const indexed = entries.filter((e) => e.index !== null);
  const lines = ['<PARAM>'];
  for (const e of scalars) lines.push(fld(e, '  '));

  if (indexed.length) {
    const indexes = [...new Set(indexed.map((e) => e.index))].sort((a, b) => a - b);
    lines.push(`  <TAB DIM="999" ID="GRP${scalars.length ? 2 : 1}" SIZE="${indexes.length}">`);
    indexes.forEach((idx, i) => {
      lines.push(`    <LIN NUM="${i + 1}">`);
      for (const e of indexed.filter((x) => x.index === idx)) lines.push(fld(e, '      '));
      lines.push('    </LIN>');
    });
    lines.push('  </TAB>');
  }
  lines.push('</PARAM>');
  return lines.join('\n');
}

// An empty payload: <PARAM> with only whitespace, or <PARAM/>.
const EMPTY_PARAM_RE = /<PARAM\b[^>]*?(?:\/>|>\s*<\/PARAM>)/;

/**
 * Returns { xml, applied, reason }. The inputs are written into REQUEST_XML
 * only when its <PARAM> payload is empty; a payload that already carries
 * fields is left exactly as authored.
 */
export function applyInputParameters(requestXml, inputParameters, expectedResponse = '') {
  const { entries, unparsed } = parseInputParameters(inputParameters);
  if (!entries.length) return { xml: requestXml, applied: false, reason: 'no-inputs', unparsed };
  if (!EMPTY_PARAM_RE.test(requestXml)) {
    return { xml: requestXml, applied: false, reason: 'param-present', unparsed };
  }
  const param = buildParamXml(entries, expectedResponse);
  return {
    xml: requestXml.replace(EMPTY_PARAM_RE, () => param),
    applied: true,
    reason: 'param-empty',
    unparsed,
  };
}

/** Flattens the <PARAM> payload of a request into [{ name, lin, type, value }]. */
export function readParamFields(requestXml) {
  const param = /<PARAM\b[^>]*>([\s\S]*?)<\/PARAM>/.exec(requestXml)?.[1] ?? '';
  const fields = [];
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const fldRe = /<FLD\s+NAME="([^"]+)"(?:\s+TYPE="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/FLD>)/g;
  const lins = [...param.matchAll(/<LIN\s+NUM="(\d+)"\s*>([\s\S]*?)<\/LIN>/g)];
  for (const lin of lins) {
    for (const m of lin[2].matchAll(fldRe)) {
      fields.push({ name: m[1], lin: Number(lin[1]), type: m[2], value: unescape((m[3] ?? '').trim()) });
    }
  }
  const outside = param.replace(/<LIN\b[\s\S]*?<\/LIN>/g, '');
  for (const m of outside.matchAll(fldRe)) {
    fields.push({ name: m[1], lin: null, type: m[2], value: unescape((m[3] ?? '').trim()) });
  }
  return fields;
}

/**
 * Lists every way a request's <PARAM> payload disagrees with INPUT_PARAMETERS:
 *   missing   - an input has no matching field in the payload
 *   value     - the field is there with a different value
 *   structure - an unindexed input sits inside a table row (or vice versa)
 *   extra     - the payload has a field INPUT_PARAMETERS never mentions
 * Values are compared as text, so 5.00 vs 5 is reported as a difference.
 */
export function compareInputs(requestXml, inputParameters) {
  const { entries } = parseInputParameters(inputParameters);
  const fields = readParamFields(requestXml);
  const problems = [];
  const indexes = [...new Set(entries.filter((e) => e.index !== null).map((e) => e.index))].sort((a, b) => a - b);
  const used = new Set();

  for (const e of entries) {
    const lin = e.index === null ? null : indexes.indexOf(e.index) + 1;
    const label = e.index === null ? e.name : `${e.name}(${e.index})`;
    let hit = fields.find((f) => f.name === e.name && f.lin === lin && !used.has(f));
    if (!hit) {
      const elsewhere = fields.find((f) => f.name === e.name && !used.has(f));
      if (elsewhere) {
        used.add(elsewhere);
        problems.push({ kind: 'structure', field: label, detail: `found ${elsewhere.lin === null ? 'outside' : `in LIN ${elsewhere.lin} of`} the table, expected ${lin === null ? 'outside' : `in LIN ${lin} of`} it` });
        continue;
      }
      problems.push({ kind: 'missing', field: label, detail: `input value "${e.value}" is not in REQUEST_XML` });
      continue;
    }
    used.add(hit);
    if (hit.value !== e.value) {
      problems.push({ kind: 'value', field: label, detail: `INPUT_PARAMETERS "${e.value}" vs REQUEST_XML "${hit.value}"` });
    }
  }
  for (const f of fields) {
    if (!used.has(f)) {
      problems.push({ kind: 'extra', field: f.lin === null ? f.name : `${f.name}[LIN ${f.lin}]`, detail: `REQUEST_XML has "${f.value}" but INPUT_PARAMETERS does not list it` });
    }
  }
  return problems;
}
