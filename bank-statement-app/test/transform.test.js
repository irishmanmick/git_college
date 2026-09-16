'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseTransactionsCsv } = require('../src/csv');
const {
  buildStatement,
  buildStatementId,
  validateBalances,
  crossCheckAccount,
  totalAmount,
  formatDateTime,
  HEADER_COLUMNS,
  LINE_COLUMNS,
} = require('../src/transform');
const { findAccount, selectableAccounts, allAccounts, accountSuffix, bankCode } = require('../src/accounts');

const SAMPLE = path.join(__dirname, '..', 'samples', 'transactions-EUR-DEB-7268.csv');
const ACCOUNT_ID = 'CL:EUR-DEB';

function sampleTransactions() {
  return parseTransactionsCsv(fs.readFileSync(SAMPLE, 'utf8')).transactions;
}

test('the account master list is loaded and excludes retired accounts', () => {
  const all = allAccounts();
  const selectable = selectableAccounts();
  assert.equal(all.length, 37);
  assert.equal(selectable.length, 31);
  assert.ok(selectable.every((a) => !/MUST BE (EXCLUDED|DELETED)/i.test(a.name)));
  assert.ok(selectable.every((a) => a.bankAccount && a.currency && a.id));
  // Account ids are unique, so a selection is never ambiguous.
  assert.equal(new Set(all.map((a) => a.id)).size, all.length);
});

test('the Clonee euro debtors account resolves and matches the mapping example', () => {
  const account = findAccount(ACCOUNT_ID);
  assert.ok(account);
  assert.equal(account.bankAccount, 'EUR-DEB');
  assert.equal(account.currency, 'EUR');
  assert.equal(account.iban, 'IE71AIBK93110114007268');
  assert.equal(accountSuffix(account), '7268');
  assert.equal(bankCode(account), 'AIB');
});

test('the statement ID follows BANK-CCY-ACCT-DDMMYYYY', () => {
  const account = findAccount(ACCOUNT_ID);
  const id = buildStatementId(account, new Date(Date.UTC(2026, 8, 4)));
  assert.equal(id, 'AIB-EUR-7268-04092026');
});

test('an excluded account cannot be selected', () => {
  assert.equal(findAccount('LD:USD-DEB'), null);
});

test('formatDateTime produces the mapped date formats', () => {
  const date = new Date(Date.UTC(2026, 8, 4));
  assert.equal(formatDateTime(date, false), '2026-09-04 00:00:00');
  assert.equal(formatDateTime(date, true), '2026-09-04 23:59:59');
});

test('balances reconcile when opening plus transactions equals closing', () => {
  const transactions = sampleTransactions();
  assert.equal(totalAmount(transactions), 45348.56);

  const ok = validateBalances(0, 45348.56, transactions);
  assert.equal(ok.valid, true);
  assert.equal(ok.difference, 0);
  assert.equal(ok.expectedClosingBalance, 45348.56);
  assert.equal(ok.transactionCount, 5);
  assert.equal(ok.creditCount, 3);
  assert.equal(ok.debitCount, 2);
  assert.equal(ok.creditTotal, 51149.11);
  assert.equal(ok.debitTotal, -5800.55);

  const shifted = validateBalances(10000, 55348.56, transactions);
  assert.equal(shifted.valid, true);
});

test('balances that do not reconcile are rejected with the difference', () => {
  const transactions = sampleTransactions();
  const bad = validateBalances(0, 45000, transactions);
  assert.equal(bad.valid, false);
  assert.equal(bad.difference, -348.56);

  const outByACent = validateBalances(0, 45348.57, transactions);
  assert.equal(outByACent.valid, false);
});

test('floating point noise does not break the balance check', () => {
  const transactions = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map((amount, i) => ({
    amount,
    date: new Date(Date.UTC(2026, 8, 4 + i)),
    creditDebit: 'Credit',
    lineStatus: 'Booked',
    narrative: '',
    reference: '',
    creditorName: '',
    debtorName: '',
    ibanOrAccount: '',
    currency: 'EUR',
  }));
  const result = validateBalances(0, 2.8, transactions);
  assert.equal(result.transactionTotal, 2.8);
  assert.equal(result.valid, true);
});

test('buildStatement fills the header per Header_Mapping', () => {
  const account = findAccount(ACCOUNT_ID);
  const statement = buildStatement({
    account,
    openingBalance: 1000,
    closingBalance: 46348.56,
    transactions: sampleTransactions(),
  });

  assert.deepEqual(Object.keys(statement.header), HEADER_COLUMNS);
  assert.deepEqual(statement.header, {
    STATEMENTID: 'AIB-EUR-7268-06092026',
    BANKACCOUNT: 'EUR-DEB',
    CURRENCY: 'EUR',
    ENDINGBALANCE: 46348.56,
    FROMDATE: '2026-09-04 00:00:00',
    OPENINGBALANCE: 1000,
    TODATE: '2026-09-06 23:59:59',
  });
});

test('buildStatement fills the lines per Lines_Mapping', () => {
  const account = findAccount(ACCOUNT_ID);
  const { lines, statementId } = buildStatement({
    account,
    openingBalance: 0,
    closingBalance: 45348.56,
    transactions: sampleTransactions(),
  });

  assert.equal(lines.length, 5);
  assert.deepEqual(Object.keys(lines[0]), LINE_COLUMNS);

  // LINENUMBER is sequential from 1 and STATEMENTID is the header's, on every line.
  assert.deepEqual(lines.map((l) => l.LINENUMBER), [1, 2, 3, 4, 5]);
  assert.ok(lines.every((l) => l.STATEMENTID === statementId));
  assert.ok(lines.every((l) => l.BANKACCOUNT === 'EUR-DEB'));

  assert.deepEqual(lines[0], {
    LINENUMBER: 1,
    BANKACCOUNT: 'EUR-DEB',
    STATEMENTID: 'AIB-EUR-7268-06092026',
    BOOKINGDATE: '2026-09-04 00:00:00',
    AMOUNT: 37668.91,
    BANKSTATEMENTTRANSACTIONCODE: '',
    COUNTERAMOUNT: 0,
    COUNTERCURRENCY: '',
    COUNTEREXCHANGERATE: 0,
    CREDITORREFERENCEINFORMATION: '',
    DOCUMENTNUMBER: '',
    ENTRYREFERENCE: 'BAUMANN GMBH CO. IE26090367466930',
    INSTRUCTEDAMOUNT: 0,
    INSTRUCTEDCURRENCY: '',
    INSTRUCTEDEXCHANGERATE: 0,
    LINESTATUS: 'Booked',
    REFERENCENUMBER: 'IE26090367466930',
    RELATEDBANK: '',
    RELATEDBANKACCOUNT: '',
    REVERSAL: 'No',
    TRADINGPARTY: 'Baumann GmbH & Co. KG',
  });
});

test('TRADINGPARTY takes the debtor for credits and the creditor for debits', () => {
  const account = findAccount(ACCOUNT_ID);
  const { lines } = buildStatement({
    account,
    openingBalance: 0,
    closingBalance: 45348.56,
    transactions: sampleTransactions(),
  });

  const debit = lines.find((l) => l.AMOUNT === -4300.55);
  assert.equal(debit.TRADINGPARTY, 'Nordic Haulage AB');

  const credit = lines.find((l) => l.AMOUNT === 12500);
  assert.equal(credit.TRADINGPARTY, 'Meat Traders Ltd');
});

test('a pending CSV row becomes LINESTATUS Pending', () => {
  const account = findAccount(ACCOUNT_ID);
  const { lines } = buildStatement({
    account,
    openingBalance: 0,
    closingBalance: 45348.56,
    transactions: sampleTransactions(),
  });
  const pending = lines.find((l) => l.AMOUNT === -1500);
  assert.equal(pending.LINESTATUS, 'Pending');
});

test('lines are ordered by booking date', () => {
  const account = findAccount(ACCOUNT_ID);
  const transactions = sampleTransactions().reverse();
  const { lines } = buildStatement({
    account,
    openingBalance: 0,
    closingBalance: 45348.56,
    transactions,
  });
  const dates = lines.map((l) => l.BOOKINGDATE);
  assert.deepEqual([...dates].sort(), dates);
});

test('buildStatement refuses an empty transaction list', () => {
  const account = findAccount(ACCOUNT_ID);
  assert.throws(
    () => buildStatement({ account, openingBalance: 0, closingBalance: 0, transactions: [] }),
    /At least one transaction/
  );
});

test('the CSV account and currency are cross-checked against the selection', () => {
  const transactions = sampleTransactions();
  assert.deepEqual(crossCheckAccount(findAccount(ACCOUNT_ID), transactions), []);

  const wrongAccount = crossCheckAccount(findAccount('KB:EUR-CUR'), transactions);
  assert.equal(wrongAccount.length, 1);
  assert.match(wrongAccount[0], /does not look like the selected account/);

  const gbp = crossCheckAccount(findAccount('CL:GBP-DEB'), transactions);
  assert.ok(gbp.some((w) => /EUR transactions but the selected account is GBP/.test(w)));
});
