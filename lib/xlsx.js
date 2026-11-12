/**
 * A small, dependency-free reader and writer for .xlsx workbooks.
 *
 * The app has no spreadsheet library, and the only thing it needs from a
 * workbook is "the text of every cell in every sheet", so this reads exactly
 * that: the ZIP container (Node's zlib inflates the parts), workbook.xml for
 * the sheet names and order, sharedStrings.xml, and each sheet's cells.
 *
 * Cell values are returned as the strings stored in the file. A cell stored as
 * a NUMBER is reported separately (`numericCells`), because a number has
 * already lost any leading zeros ("020453" -> 20453) and the caller decides
 * whether that is acceptable. The writer stores every value as text and
 * formats the first column of a sheet as Text, so codes typed into it later in
 * Excel stay text too.
 */
import zlib from 'node:zlib';

// ---------------------------------------------------------------- ZIP reading

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function readZipEntries(buffer) {
  // The end-of-central-directory record is within the last 64 KB + 22 bytes.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a valid .xlsx (ZIP) file');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) throw new Error('corrupt ZIP directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    const at = entry.localOffset;
    if (buffer.readUInt32LE(at) !== SIG_LOCAL) throw new Error('corrupt ZIP entry');
    const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
    const data = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data.toString('utf8');
    if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error(`unsupported ZIP compression method ${entry.method}`);
  };
}

// ------------------------------------------------------------------ XML bits

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    switch (e.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return e[1].toLowerCase() === 'x'
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters other than tab/CR/LF are not legal in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

/** "A" -> 0, "B" -> 1, "AA" -> 26 */
function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 -> "A", 26 -> "AA" */
function columnLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = re.exec(xml))) {
    // Phonetic runs (<rPh>) are furigana, not part of the value.
    const body = (m[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const t = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let tm;
    while ((tm = t.exec(body))) text += decodeXml(tm[1] ?? '');
    out.push(text);
  }
  return out;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const numericCells = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  let autoRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const rowNumber = Number(attr(rm[1], 'r')) || autoRow + 1;
    autoRow = rowNumber;
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let autoCol = 0;
    while ((cm = cellRe.exec(rm[2] ?? ''))) {
      const ref = attr(cm[1], 'r');
      const col = ref ? columnIndex(/^[A-Z]+/i.exec(ref)[0].toUpperCase()) : autoCol;
      autoCol = col + 1;
      const type = attr(cm[1], 't');
      const body = cm[2] ?? '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      let value = '';
      if (type === 's') {
        value = v ? (sharedStrings[Number(v[1])] ?? '') : '';
      } else if (type === 'inlineStr') {
        let text = '';
        const t = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
        let tm;
        while ((tm = t.exec(body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')))) text += decodeXml(tm[1] ?? '');
        value = text;
      } else if (v) {
        value = decodeXml(v[1]);
        if (type == null || type === 'n') {
          numericCells.push(`${columnLetters(col)}${rowNumber}`);
        }
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = '';
    rows[rowNumber - 1] = cells;
  }
  for (let i = 0; i < rows.length; i += 1) if (rows[i] === undefined) rows[i] = [];
  return { rows, numericCells };
}

/**
 * Reads every worksheet of an .xlsx workbook, in workbook order.
 * Returns [{ name, rows: string[][], numericCells: string[] }]. Throws an Error
 * with a readable message when the file is not a usable workbook.
 */
export function readWorkbook(buffer) {
  let read;
  try {
    read = readZipEntries(buffer);
  } catch (err) {
    throw new Error(`The workbook could not be read: ${err.message}.`);
  }

  const workbookXml = read('xl/workbook.xml');
  if (!workbookXml) throw new Error('The workbook could not be read: xl/workbook.xml is missing.');
  const relsXml = read('xl/_rels/workbook.xml.rels') ?? '';

  const targets = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) targets.set(id, target);
  }

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));
  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    let target = targets.get(rid);
    if (!name || !target) continue;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = read(target);
    if (xml == null) throw new Error(`The workbook could not be read: sheet "${name}" is missing.`);
    sheets.push({ name, ...parseSheet(xml, sharedStrings) });
  }
  if (!sheets.length) throw new Error('The workbook has no worksheets.');
  return sheets;
}

// ------------------------------------------------------------------- writing

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data, 'utf8');
    const packed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// cellXfs indexes in styles.xml below.
const STYLE_DEFAULT = 0;
const STYLE_TEXT = 1; // number format "@" (Text) - keeps leading zeros when typed
const STYLE_HEADER = 2; // bold

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * Builds an .xlsx. sheets: [{ name, rows: string[][], textColumns?: number[],
 * widths?: number[] }]. Every value is written as text; `textColumns` also get
 * the Text number format on the whole column, so a value typed into a new row
 * later (e.g. 020453) is kept as text, zeros and all.
 */
export function writeWorkbook(sheets) {
  const strings = [];
  const stringIndex = new Map();
  const sst = (text) => {
    let i = stringIndex.get(text);
    if (i === undefined) {
      i = strings.length;
      strings.push(text);
      stringIndex.set(text, i);
    }
    return i;
  };

  const sheetXml = sheets.map((sheet) => {
    const textCols = new Set(sheet.textColumns ?? []);
    const width = Math.max(0, ...sheet.rows.map((r) => r.length));
    const rowsXml = sheet.rows
      .map((row, r) => {
        const cells = [];
        for (let c = 0; c < width; c += 1) {
          const value = row[c];
          if (value === undefined || value === null || value === '') continue;
          const style = r === 0 ? STYLE_HEADER : textCols.has(c) ? STYLE_TEXT : STYLE_DEFAULT;
          cells.push(
            `<c r="${columnLetters(c)}${r + 1}" s="${style}" t="s"><v>${sst(String(value))}</v></c>`
          );
        }
        return `<row r="${r + 1}">${cells.join('')}</row>`;
      })
      .join('');
    const cols = Array.from({ length: width }, (_, c) => {
      const w = sheet.widths?.[c] ?? 20;
      const style = textCols.has(c) ? ' style="1"' : '';
      return `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"${style}/>`;
    }).join('');
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${cols}</cols><sheetData>${rowsXml}</sheetData></worksheet>`
    );
  });

  const sstXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
    '</sst>';

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' +
        sheets
          .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/sharedStrings.xml', data: sstXml },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ];

  return buildZip(files);
}
