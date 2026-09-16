'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseTransactionsCsv,
  parseAmount,
  parseDate,
  parseCreditDebit,
  parseLineStatus,
} = require('../src/csv');

const SAMPLE = path.join(__dirname, '..', 'samples', 'transactions-EUR-DEB-7268.csv');

test('parseAmount handles separators, brackets and signs', () => {
  assert.deepEqual(parseAmount('37668.91'), { value: 37668.91, negative: false });
  assert.deepEqual(parseAmount('1,234.56'), { value: 1234.56, negative: false });
  assert.deepEqual(parseAmount('1.234,56'), { value: 1234.56, negative: false });
  assert.deepEqual(parseAmount('(500.00)'), { value: 500, negative: true });
  assert.deepEqual(parseAmount('-250.50'), { value: 250.5, negative: true });
  assert.deepEqual(parseAmount('€ 99.00'), { value: 99, negative: false });
  assert.equal(parseAmount('').value, null);
  assert.equal(parseAmount('abc').value, null);
});

test('parseDate reads DD/MM/YYYY and rejects impossible dates', () => {
  assert.equal(parseDate('04/09/2026').toISOString(), '2026-09-04T00:00:00.000Z');
  assert.equal(parseDate('4-9-2026').toISOString(), '2026-09-04T00:00:00.000Z');
  assert.equal(parseDate('2026-09-04').toISOString(), '2026-09-04T00:00:00.000Z');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('not a date'), null);
});

test('day-first parsing is not confused by US-style reading', () => {
  // 13 cannot be a month, so this is unambiguous: 13 December.
  assert.equal(parseDate('13/12/2026').toISOString(), '2026-12-13T00:00:00.000Z');
  // 04/09 is ambiguous; the bank export is DD/MM so it must be 4 September.
  assert.equal(parseDate('04/09/2026').getUTCMonth(), 8);
});

test('parseCreditDebit and parseLineStatus map the CSV indicators', () => {
  assert.equal(parseCreditDebit('Credit'), 'Credit');
  assert.equal(parseCreditDebit('CR'), 'Credit');
  assert.equal(parseCreditDebit('d'), 'Debit');
  assert.equal(parseCreditDebit('Debit'), 'Debit');
  assert.equal(parseCreditDebit('unknown'), null);

  assert.equal(parseLineStatus('H'), 'Booked');
  assert.equal(parseLineStatus('P'), 'Pending');
  assert.equal(parseLineStatus(''), 'Booked');
});

test('the sample CSV parses into five signed transactions', () => {
  const result = parseTransactionsCsv(fs.readFileSync(SAMPLE, 'utf8'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.transactions.length, 5);

  const amounts = result.transactions.map((t) => t.amount);
  assert.deepEqual(amounts, [37668.91, 12500, -4300.55, 980.2, -1500]);

  const first = result.transactions[0];
  assert.equal(first.ibanOrAccount, 'IE71AIBK93110114007268');
  assert.equal(first.currency, 'EUR');
  assert.equal(first.lineStatus, 'Booked');
  assert.equal(first.reference, 'IE26090367466930');
  assert.equal(first.debtorName, 'Baumann GmbH & Co. KG');
  assert.equal(first.narrative, 'BAUMANN GMBH CO. IE26090367466930');

  assert.equal(result.transactions[4].lineStatus, 'Pending');
});

test('quoted fields containing commas and quotes survive parsing', () => {
  const csv =
    'Amount,Credit / Debit,Date,Transaction Narrative\n' +
    '10.00,Credit,01/01/2026,"PAYMENT, THANKS ""REF"" 1"\n';
  const result = parseTransactionsCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.transactions[0].narrative, 'PAYMENT, THANKS "REF" 1');
});

test('semicolon-delimited exports are detected', () => {
  const csv = 'Amount;Credit / Debit;Date\n100,50;Credit;04/09/2026\n';
  const result = parseTransactionsCsv(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.transactions[0].amount, 100.5);
});

test('missing required columns are reported, not guessed', () => {
  const result = parseTransactionsCsv('Amount,Date\n10.00,04/09/2026\n');
  assert.equal(result.transactions.length, 0);
  assert.match(result.errors[0], /Credit \/ Debit/);
});

test('unreadable rows are skipped and reported', () => {
  const csv =
    'Amount,Credit / Debit,Date\n' +
    '10.00,Credit,04/09/2026\n' +
    'oops,Credit,05/09/2026\n' +
    '20.00,Credit,31/02/2026\n';
  const result = parseTransactionsCsv(csv);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.skippedRows, 2);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /row 3/);
  assert.match(result.errors[1], /row 4/);
});

test('an unrecognised Credit / Debit value falls back to the amount sign with a warning', () => {
  const csv = 'Amount,Credit / Debit,Date\n-45.00,?,04/09/2026\n';
  const result = parseTransactionsCsv(csv);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, -45);
  assert.equal(result.transactions[0].creditDebit, 'Debit');
  assert.equal(result.warnings.length, 1);
});

test('an empty CSV is an error, not an empty statement', () => {
  assert.equal(parseTransactionsCsv('').transactions.length, 0);
  assert.match(parseTransactionsCsv('').errors[0], /empty/i);
  assert.match(
    parseTransactionsCsv('Amount,Credit / Debit,Date\n').errors[0],
    /no transaction rows/i
  );
});

test('a UTF-8 BOM does not break header matching', () => {
  const result = parseTransactionsCsv('﻿Amount,Credit / Debit,Date\n10.00,Credit,04/09/2026\n');
  assert.deepEqual(result.errors, []);
  assert.equal(result.transactions.length, 1);
});
