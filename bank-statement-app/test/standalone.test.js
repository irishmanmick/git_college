'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { parseTransactionsCsv } = require('../src/csv');
const { buildStatement, HEADER_COLUMNS, LINE_COLUMNS } = require('../src/transform');
const { findAccount } = require('../src/accounts');
const { renderStatementWorkbook } = require('../src/workbook');
const { renderStatementXlsx, columnLetter, numberText, stripIllegalXmlChars, crc32 } = require('../src/xlsx-browser');
const { build, OUTPUT } = require('../tools/build-standalone');

const SAMPLE = path.join(__dirname, '..', 'samples', 'transactions-EUR-DEB-7268.csv');
const ACCOUNT_ID = 'CL:EUR-DEB';
const FIXED_DATE = new Date(Date.UTC(2026, 8, 6, 12, 0, 0));

function sampleStatement(overrides = {}) {
  const transactions = parseTransactionsCsv(fs.readFileSync(SAMPLE, 'utf8')).transactions;
  return buildStatement({
    account: findAccount(ACCOUNT_ID),
    openingBalance: 0,
    closingBalance: 45348.56,
    transactions,
    ...overrides,
  });
}

test('columnLetter covers single and double letters', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(21), 'U'); // the widest sheet ends at U
  assert.equal(columnLetter(26), 'Z');
  assert.equal(columnLetter(27), 'AA');
});

test('numberText avoids exponent notation, which Excel rejects', () => {
  assert.equal(numberText(0), '0');
  assert.equal(numberText(-1500), '-1500');
  assert.equal(numberText(37668.91), '37668.91');
  assert.equal(numberText(980.2), '980.2');
  assert.equal(numberText(0.0000001), '0');
  assert.ok(!numberText(0.000001).includes('e'));
});

test('illegal XML control characters are stripped, legal whitespace kept', () => {
  assert.equal(stripIllegalXmlChars('ab'), 'ab');
  assert.equal(stripIllegalXmlChars(`a${String.fromCharCode(3)}b`), 'ab');
  assert.equal(stripIllegalXmlChars('a\tb\nc\rd'), 'a\tb\nc\rd');
});

test('crc32 matches the known check value', () => {
  // The standard CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('the dependency-free writer produces a readable xlsx', async () => {
  const bytes = renderStatementXlsx(sampleStatement(), FIXED_DATE);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));

  assert.deepEqual(
    workbook.worksheets.map((w) => w.name),
    ['Bank_statement_header', 'Bank_statement_lines']
  );
  const lines = workbook.getWorksheet('Bank_statement_lines');
  assert.equal(lines.getRow(2).getCell(5).value, 37668.91);
  assert.equal(lines.getRow(2).getCell(5).numFmt, '0.000000');
  assert.equal(lines.getRow(2).getCell(9).numFmt, '0.0000000000000000');
});

test('the browser writer and the template writer agree cell for cell', async () => {
  const statement = sampleStatement();

  const fromTemplate = new ExcelJS.Workbook();
  await fromTemplate.xlsx.load(await renderStatementWorkbook(statement));

  const fromBrowser = new ExcelJS.Workbook();
  await fromBrowser.xlsx.load(Buffer.from(renderStatementXlsx(statement, FIXED_DATE)));

  const sheets = [
    ['Bank_statement_header', HEADER_COLUMNS, 1],
    ['Bank_statement_lines', LINE_COLUMNS, statement.lines.length],
  ];

  let compared = 0;
  for (const [name, columns, dataRows] of sheets) {
    const a = fromTemplate.getWorksheet(name);
    const b = fromBrowser.getWorksheet(name);
    assert.ok(a && b, `both workbooks have ${name}`);

    for (let row = 1; row <= dataRows + 1; row += 1) {
      for (let col = 1; col <= columns.length; col += 1) {
        const ca = a.getRow(row).getCell(col);
        const cb = b.getRow(row).getCell(col);
        const va = ca.value === undefined ? null : ca.value;
        const vb = cb.value === undefined ? null : cb.value;
        assert.deepEqual(vb, va, `${name} r${row}c${col} value`);
        assert.equal(cb.numFmt || '', ca.numFmt || '', `${name} r${row}c${col} format`);
        compared += 1;
      }
    }
  }
  // 2 header rows x 7 columns, plus 6 line rows x 21 columns.
  assert.equal(compared, 2 * 7 + 6 * 21);
});

test('an amount needing all 6 decimals survives both writers identically', async () => {
  const transactions = [
    {
      amount: 0.123456,
      date: new Date(Date.UTC(2026, 8, 4)),
      creditDebit: 'Credit',
      lineStatus: 'Booked',
      narrative: 'PRECISION & "QUOTED" <TEST>',
      reference: 'REF1',
      creditorName: '',
      debtorName: 'Tiny Amounts Ltd',
      ibanOrAccount: '',
      currency: 'EUR',
    },
  ];
  const statement = buildStatement({
    account: findAccount(ACCOUNT_ID),
    openingBalance: 0,
    closingBalance: 0.123456,
    transactions,
  });

  const fromTemplate = new ExcelJS.Workbook();
  await fromTemplate.xlsx.load(await renderStatementWorkbook(statement));
  const fromBrowser = new ExcelJS.Workbook();
  await fromBrowser.xlsx.load(Buffer.from(renderStatementXlsx(statement, FIXED_DATE)));

  for (const wb of [fromTemplate, fromBrowser]) {
    const line = wb.getWorksheet('Bank_statement_lines').getRow(2);
    assert.equal(line.getCell(5).value, 0.123456);
    // Characters that must be escaped in XML round-trip intact.
    assert.equal(line.getCell(12).value, 'PRECISION & "QUOTED" <TEST>');
  }
});

test('the committed standalone file is up to date with its sources', () => {
  const committed = fs.readFileSync(OUTPUT, 'utf8');
  assert.equal(
    committed,
    build(),
    'bank-statement-tool.html is stale — run `npm run build:standalone` and commit the result.'
  );
});

test('the standalone file is self-contained: no external references', () => {
  const html = fs.readFileSync(OUTPUT, 'utf8');
  assert.ok(!/<script[^>]+\ssrc=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheets');
  assert.ok(!/https?:\/\/[^"'\s]*\.(js|css)/i.test(html), 'no remote js or css');
  // It must not call the server API, since there is no server.
  assert.ok(!html.includes("fetch('/api/"), 'no API calls');
  // The account list and the four steps are embedded.
  assert.ok(html.includes('"IE71AIBK93110114007268"'), 'account list embedded');
  assert.ok(html.includes('id="panel-4"'), 'all four steps present');
});
