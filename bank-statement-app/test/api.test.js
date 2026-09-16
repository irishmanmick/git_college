'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { app, parseNumber } = require('../server');
const { parseTransactionsCsv } = require('../src/csv');
const { HEADER_COLUMNS, LINE_COLUMNS } = require('../src/transform');
const { readHeaderRow, TEMPLATE_FILE, HEADER_SHEET, LINES_SHEET } = require('../src/workbook');

const SAMPLE = path.join(__dirname, '..', 'samples', 'transactions-EUR-DEB-7268.csv');
const ACCOUNT_ID = 'CL:EUR-DEB';
const CLOSING = 45348.56;

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

function serialise(transactions) {
  return transactions.map((t) => ({ ...t, date: t.date.toISOString().slice(0, 10) }));
}

function sampleCsvText() {
  return fs.readFileSync(SAMPLE, 'utf8');
}

async function postJson(pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function uploadSample() {
  const form = new FormData();
  form.append('accountId', ACCOUNT_ID);
  form.append('file', new Blob([sampleCsvText()], { type: 'text/csv' }), 'sample.csv');
  const res = await fetch(`${base}/api/transactions`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

test('the template in data/ still has the columns the code writes', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_FILE);
  assert.deepEqual(readHeaderRow(workbook.getWorksheet(HEADER_SHEET)), HEADER_COLUMNS);
  assert.deepEqual(readHeaderRow(workbook.getWorksheet(LINES_SHEET)), LINE_COLUMNS);
});

test('parseNumber accepts the formats a user might type', () => {
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('(500)'), -500);
  assert.equal(parseNumber('-10.5'), -10.5);
  assert.equal(parseNumber('0'), 0);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(undefined), null);
});

test('GET /api/accounts lists selectable accounts with labels', async () => {
  const res = await fetch(`${base}/api/accounts`);
  assert.equal(res.status, 200);
  const { accounts } = await res.json();
  assert.equal(accounts.length, 31);

  const account = accounts.find((a) => a.id === ACCOUNT_ID);
  assert.equal(account.label, 'CL · EUR-DEB · EUR — Debtors Account: Euro');
  assert.equal(account.statementIdPrefix, 'AIB-EUR-7268');
  assert.ok(accounts.every((a) => !/MUST BE (EXCLUDED|DELETED)/i.test(a.name)));
});

test('POST /api/transactions summarises the uploaded CSV', async () => {
  const { status, body } = await uploadSample();
  assert.equal(status, 200);
  assert.equal(body.transactionCount, 5);
  assert.equal(body.creditCount, 3);
  assert.equal(body.debitCount, 2);
  assert.equal(body.transactionTotal, CLOSING);
  assert.equal(body.fromDate, '2026-09-04');
  assert.equal(body.toDate, '2026-09-06');
  assert.deepEqual(body.rowErrors, []);
  assert.deepEqual(body.warnings, []);
});

test('POST /api/transactions rejects an upload with no account or no file', async () => {
  const noAccount = new FormData();
  noAccount.append('file', new Blob([sampleCsvText()]), 'sample.csv');
  const res1 = await fetch(`${base}/api/transactions`, { method: 'POST', body: noAccount });
  assert.equal(res1.status, 400);

  const noFile = new FormData();
  noFile.append('accountId', ACCOUNT_ID);
  const res2 = await fetch(`${base}/api/transactions`, { method: 'POST', body: noFile });
  assert.equal(res2.status, 400);
  assert.match((await res2.json()).error, /No CSV file/);
});

test('POST /api/transactions warns when the CSV belongs to another account', async () => {
  const form = new FormData();
  form.append('accountId', 'KB:EUR-CUR');
  form.append('file', new Blob([sampleCsvText()]), 'sample.csv');
  const res = await fetch(`${base}/api/transactions`, { method: 'POST', body: form });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.warnings.some((w) => /does not look like the selected account/.test(w)));
});

test('POST /api/verify-balances accepts a reconciling pair', async () => {
  const transactions = serialise(parseTransactionsCsv(sampleCsvText()).transactions);
  const { status, body } = await postJson('/api/verify-balances', {
    accountId: ACCOUNT_ID,
    openingBalance: '0',
    closingBalance: '45,348.56',
    transactions,
  });
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.statementId, 'AIB-EUR-7268-06092026');
  assert.equal(body.currency, 'EUR');
  assert.match(body.message, /verified/i);
});

test('POST /api/verify-balances rejects a pair that does not reconcile', async () => {
  const transactions = serialise(parseTransactionsCsv(sampleCsvText()).transactions);
  const { status, body } = await postJson('/api/verify-balances', {
    accountId: ACCOUNT_ID,
    openingBalance: '100',
    closingBalance: '45348.56',
    transactions,
  });
  assert.equal(status, 200);
  assert.equal(body.valid, false);
  assert.equal(body.difference, -100);
  assert.match(body.message, /do not reconcile/i);
});

test('POST /api/verify-balances requires both balances as numbers', async () => {
  const transactions = serialise(parseTransactionsCsv(sampleCsvText()).transactions);
  const { status, body } = await postJson('/api/verify-balances', {
    accountId: ACCOUNT_ID,
    openingBalance: '',
    closingBalance: 'abc',
    transactions,
  });
  assert.equal(status, 400);
  assert.match(body.error, /opening balance and a closing balance/);
});

test('POST /api/generate refuses to build a file that does not reconcile', async () => {
  const transactions = serialise(parseTransactionsCsv(sampleCsvText()).transactions);
  const { status, body } = await postJson('/api/generate', {
    accountId: ACCOUNT_ID,
    openingBalance: 0,
    closingBalance: 1,
    transactions,
  });
  assert.equal(status, 422);
  assert.match(body.error, /do not reconcile/);
  assert.equal(body.validation.valid, false);
});

test('POST /api/generate returns the populated template named after the statement ID', async () => {
  const transactions = serialise(parseTransactionsCsv(sampleCsvText()).transactions);
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: ACCOUNT_ID,
      openingBalance: 0,
      closingBalance: CLOSING,
      transactions,
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-statement-id'), 'AIB-EUR-7268-06092026');
  assert.match(
    res.headers.get('content-disposition'),
    /filename="AIB-EUR-7268-06092026\.xlsx"/
  );

  const buffer = Buffer.from(await res.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const headerSheet = workbook.getWorksheet(HEADER_SHEET);
  const linesSheet = workbook.getWorksheet(LINES_SHEET);
  assert.deepEqual(readHeaderRow(headerSheet), HEADER_COLUMNS);
  assert.deepEqual(readHeaderRow(linesSheet), LINE_COLUMNS);

  const headerValues = HEADER_COLUMNS.map((_, i) => headerSheet.getRow(2).getCell(i + 1).value);
  assert.deepEqual(headerValues, [
    'AIB-EUR-7268-06092026',
    'EUR-DEB',
    'EUR',
    CLOSING,
    '2026-09-04 00:00:00',
    0,
    '2026-09-06 23:59:59',
  ]);

  // Five transaction lines in rows 2-6, and nothing beyond them.
  assert.equal(linesSheet.getRow(6).getCell(1).value, 5);
  assert.equal(linesSheet.getRow(7).getCell(1).value, null);

  const firstLine = LINE_COLUMNS.map((_, i) => linesSheet.getRow(2).getCell(i + 1).value);
  assert.deepEqual(firstLine, [
    1,
    'EUR-DEB',
    'AIB-EUR-7268-06092026',
    '2026-09-04 00:00:00',
    37668.91,
    null,
    0,
    null,
    0,
    null,
    null,
    'BAUMANN GMBH CO. IE26090367466930',
    0,
    null,
    0,
    'Booked',
    'IE26090367466930',
    null,
    null,
    'No',
    'Baumann GmbH & Co. KG',
  ]);

  // Amounts carry the 6-decimal format the mapping specifies.
  assert.equal(linesSheet.getRow(2).getCell(5).numFmt, '0.000000');
  assert.equal(linesSheet.getRow(2).getCell(9).numFmt, '0.0000000000000000');
  assert.equal(headerSheet.getRow(2).getCell(4).numFmt, '0.000000');

  // The debit line keeps its negative sign.
  const debitRow = [3, 4, 5, 6].find(
    (r) => Number(linesSheet.getRow(r).getCell(5).value) === -4300.55
  );
  assert.ok(debitRow, 'the debit line is present with a negative amount');
  assert.equal(linesSheet.getRow(debitRow).getCell(21).value, 'Nordic Haulage AB');
});

test('POST /api/generate rejects an unknown account', async () => {
  const transactions = serialise(parseTransactionsCsv(sampleCsvText()).transactions);
  const { status } = await postJson('/api/generate', {
    accountId: 'NOPE:NOPE',
    openingBalance: 0,
    closingBalance: CLOSING,
    transactions,
  });
  assert.equal(status, 400);
});

test('POST /api/generate rejects an empty transaction list', async () => {
  const { status, body } = await postJson('/api/generate', {
    accountId: ACCOUNT_ID,
    openingBalance: 0,
    closingBalance: 0,
    transactions: [],
  });
  assert.equal(status, 400);
  assert.match(body.error, /Upload a transactions CSV/);
});

test('GET / serves the front end', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Bank Statement Generator/);
  assert.match(html, /app\.js/);
});
