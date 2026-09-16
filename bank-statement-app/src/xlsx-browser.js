'use strict';

/**
 * Writes the statement workbook with no dependencies, so the standalone
 * single-file tool works in a browser with nothing installed and no network.
 *
 * An .xlsx file is a ZIP of XML parts. Entries are stored uncompressed, which
 * Excel, the Open XML SDK and D365 all accept, and which keeps this to a
 * CRC-32 plus the ZIP headers rather than a deflate implementation.
 *
 * The sheet names, column order and cell types match what the server-side
 * writer produces from the real template; a test asserts the two agree
 * cell for cell.
 */

const { HEADER_COLUMNS, LINE_COLUMNS } = require('./transform');

const HEADER_SHEET = 'Bank_statement_header';
const LINES_SHEET = 'Bank_statement_lines';

/* Style indexes defined in styles.xml below. */
const STYLE_PLAIN = 0;
const STYLE_AMOUNT = 1; // 0.000000
const STYLE_RATE = 2; // 0.0000000000000000

const HEADER_AMOUNT_FIELDS = ['ENDINGBALANCE', 'OPENINGBALANCE'];
const LINE_AMOUNT_FIELDS = ['AMOUNT', 'COUNTERAMOUNT', 'INSTRUCTEDAMOUNT'];
const LINE_RATE_FIELDS = ['COUNTEREXCHANGERATE', 'INSTRUCTEDEXCHANGERATE'];

/* ------------------------------------------------------------------ XML */

/**
 * XML 1.0 permits only tab, newline, carriage return and characters from 0x20
 * up. Anything lower is dropped rather than escaped, since it cannot be
 * represented and would make the file unreadable.
 */
function stripIllegalXmlChars(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13 || code >= 32) out += text[i];
  }
  return out;
}

function escapeXml(value) {
  return stripIllegalXmlChars(String(value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


/** 1 -> A, 26 -> Z, 27 -> AA. */
function columnLetter(index) {
  let n = index;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Builds one sheet's XML. Strings go into the shared string table, numbers are
 * written inline, and blanks are omitted so the cell reads as empty.
 */
function sheetXml(columns, records, styleFor, strings) {
  const rows = [];

  const headerCells = columns
    .map((name, i) => {
      const ref = `${columnLetter(i + 1)}1`;
      return `<c r="${ref}" t="s"><v>${strings.index(name)}</v></c>`;
    })
    .join('');
  rows.push(`<row r="1">${headerCells}</row>`);

  records.forEach((record, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = columns
      .map((name, i) => {
        const value = record[name];
        if (value === '' || value === null || value === undefined) return '';
        const ref = `${columnLetter(i + 1)}${rowNumber}`;
        const style = styleFor(name);
        const styleAttr = style === STYLE_PLAIN ? '' : ` s="${style}"`;
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw new Error(`${name} is not a finite number.`);
          return `<c r="${ref}"${styleAttr}><v>${numberText(value)}</v></c>`;
        }
        return `<c r="${ref}"${styleAttr} t="s"><v>${strings.index(String(value))}</v></c>`;
      })
      .join('');
    rows.push(`<row r="${rowNumber}">${cells}</row>`);
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

/**
 * Numbers are stored to 6 decimal places without exponent notation, since
 * Excel does not accept 1e-7 style values in a <v> element.
 */
function numberText(value) {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(6);
  // Trim trailing zeros but keep at least one decimal digit.
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function stringTable() {
  const order = [];
  const seen = new Map();
  return {
    index(text) {
      if (seen.has(text)) return seen.get(text);
      const i = order.length;
      seen.set(text, i);
      order.push(text);
      return i;
    },
    xml() {
      return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${order.length}" uniqueCount="${order.length}">` +
        order.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
        '</sst>'
      );
    },
  };
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets>' +
  `<sheet name="${HEADER_SHEET}" sheetId="1" r:id="rId1"/>` +
  `<sheet name="${LINES_SHEET}" sheetId="2" r:id="rId2"/>` +
  '</sheets>' +
  '</workbook>';

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
  '</Relationships>';

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2">' +
  '<numFmt numFmtId="164" formatCode="0.000000"/>' +
  '<numFmt numFmtId="165" formatCode="0.0000000000000000"/>' +
  '</numFmts>' +
  '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/* ------------------------------------------------------------------ ZIP */

let crcTable = null;

function crc32Table() {
  if (crcTable) return crcTable;
  crcTable = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = crc32Table();
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

/** MS-DOS date and time, as the ZIP local/central headers store them. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Builds a ZIP archive from [{name, data: Uint8Array}] with stored entries. */
function zip(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 file names
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); // central directory signature
    dv.setUint16(4, 20, true); // version made by
    dv.setUint16(6, 20, true); // version needed
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk number
    dv.setUint16(36, 0, true); // internal attributes
    dv.setUint32(38, 0, true); // external attributes
    dv.setUint32(42, offset, true); // offset of local header
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/* -------------------------------------------------------------- public */

function headerStyleFor(name) {
  return HEADER_AMOUNT_FIELDS.indexOf(name) !== -1 ? STYLE_AMOUNT : STYLE_PLAIN;
}

function lineStyleFor(name) {
  if (LINE_AMOUNT_FIELDS.indexOf(name) !== -1) return STYLE_AMOUNT;
  if (LINE_RATE_FIELDS.indexOf(name) !== -1) return STYLE_RATE;
  return STYLE_PLAIN;
}

/**
 * Renders the statement as xlsx bytes.
 *
 * @param {{header: object, lines: object[]}} statement
 * @param {Date} [now] archive timestamp, fixed by tests for reproducibility
 * @returns {Uint8Array}
 */
function renderStatementXlsx(statement, now) {
  const strings = stringTable();
  const sheet1 = sheetXml(HEADER_COLUMNS, [statement.header], headerStyleFor, strings);
  const sheet2 = sheetXml(LINE_COLUMNS, statement.lines, lineStyleFor, strings);

  // sharedStrings is built last: both sheets must have populated the table.
  return zip(
    [
      { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES_XML) },
      { name: '_rels/.rels', data: utf8(ROOT_RELS_XML) },
      { name: 'xl/workbook.xml', data: utf8(WORKBOOK_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(WORKBOOK_RELS_XML) },
      { name: 'xl/styles.xml', data: utf8(STYLES_XML) },
      { name: 'xl/sharedStrings.xml', data: utf8(strings.xml()) },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(sheet1) },
      { name: 'xl/worksheets/sheet2.xml', data: utf8(sheet2) },
    ],
    now
  );
}

module.exports = {
  renderStatementXlsx,
  columnLetter,
  numberText,
  escapeXml,
  stripIllegalXmlChars,
  crc32,
  zip,
  HEADER_SHEET,
  LINES_SHEET,
};
