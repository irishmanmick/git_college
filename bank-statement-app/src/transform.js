'use strict';

/**
 * Builds the Bank_statement_header and Bank_statement_lines rows from parsed
 * CSV transactions, following Kepak_BankStatement_Mapping.xlsx.
 */

const { accountSuffix, bankCode } = require('./accounts');

/** Tolerance for the balance check: half a cent. */
const BALANCE_TOLERANCE = 0.005;

/** Amounts are carried to 6 decimal places, as micro-units internally. */
const SCALE = 1e6;

function toMicros(value) {
  return Math.round(Number(value) * SCALE);
}

function fromMicros(micros) {
  return micros / SCALE;
}

/** Rounds to the 6 decimal places the template uses. */
function round6(value) {
  return fromMicros(toMicros(value));
}

function pad(value, length) {
  return String(value).padStart(length, '0');
}

/** YYYY-MM-DD 00:00:00 (Header_Mapping / Lines_Mapping date format). */
function formatDateTime(date, endOfDay = false) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  return `${y}-${m}-${d} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

/** DDMMYYYY, for the statement ID. */
function formatDdmmyyyy(date) {
  return `${pad(date.getUTCDate(), 2)}${pad(date.getUTCMonth() + 1, 2)}${date.getUTCFullYear()}`;
}

/**
 * Statement ID in the recommended BANK-CCY-ACCT-DDMMYYYY format, e.g.
 * AIB-EUR-7268-04092026. The date is the statement period end date (the
 * latest transaction date in the CSV).
 */
function buildStatementId(account, statementDate) {
  const parts = [bankCode(account), (account.currency || '').toUpperCase()];
  const suffix = accountSuffix(account);
  parts.push(suffix || account.bankAccount.replace(/[^A-Za-z0-9]/g, ''));
  parts.push(formatDdmmyyyy(statementDate));
  return parts.join('-');
}

/** Sum of the signed transaction amounts, rounded to 6 dp. */
function totalAmount(transactions) {
  const micros = transactions.reduce((sum, t) => sum + toMicros(t.amount), 0);
  return fromMicros(micros);
}

/**
 * Checks opening + total transactions = closing.
 *
 * @returns {{valid: boolean, openingBalance: number, closingBalance: number,
 *            transactionTotal: number, expectedClosingBalance: number,
 *            difference: number, transactionCount: number,
 *            creditTotal: number, debitTotal: number}}
 */
function validateBalances(openingBalance, closingBalance, transactions) {
  const opening = round6(openingBalance);
  const closing = round6(closingBalance);
  const total = totalAmount(transactions);
  const expected = fromMicros(toMicros(opening) + toMicros(total));
  const difference = fromMicros(toMicros(closing) - toMicros(expected));

  const credits = transactions.filter((t) => t.amount > 0);
  const debits = transactions.filter((t) => t.amount < 0);

  return {
    valid: Math.abs(difference) < BALANCE_TOLERANCE,
    openingBalance: opening,
    closingBalance: closing,
    transactionTotal: total,
    expectedClosingBalance: expected,
    difference,
    transactionCount: transactions.length,
    creditCount: credits.length,
    debitCount: debits.length,
    creditTotal: totalAmount(credits),
    debitTotal: totalAmount(debits),
  };
}

/** Earliest and latest transaction dates, for FROMDATE / TODATE. */
function dateRange(transactions) {
  const times = transactions.map((t) => t.date.getTime());
  return {
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
  };
}

const HEADER_COLUMNS = [
  'STATEMENTID',
  'BANKACCOUNT',
  'CURRENCY',
  'ENDINGBALANCE',
  'FROMDATE',
  'OPENINGBALANCE',
  'TODATE',
];

const LINE_COLUMNS = [
  'LINENUMBER',
  'BANKACCOUNT',
  'STATEMENTID',
  'BOOKINGDATE',
  'AMOUNT',
  'BANKSTATEMENTTRANSACTIONCODE',
  'COUNTERAMOUNT',
  'COUNTERCURRENCY',
  'COUNTEREXCHANGERATE',
  'CREDITORREFERENCEINFORMATION',
  'DOCUMENTNUMBER',
  'ENTRYREFERENCE',
  'INSTRUCTEDAMOUNT',
  'INSTRUCTEDCURRENCY',
  'INSTRUCTEDEXCHANGERATE',
  'LINESTATUS',
  'REFERENCENUMBER',
  'RELATEDBANK',
  'RELATEDBANKACCOUNT',
  'REVERSAL',
  'TRADINGPARTY',
];

/**
 * Builds the statement from a selected account, verified balances and the
 * parsed CSV transactions.
 *
 * @param {object} args
 * @param {object} args.account      row from the account master list
 * @param {number} args.openingBalance
 * @param {number} args.closingBalance
 * @param {Array}  args.transactions parsed CSV transactions
 * @param {string} [args.statementId] override for the generated ID
 */
function buildStatement({ account, openingBalance, closingBalance, transactions, statementId }) {
  if (!account) throw new Error('An account must be selected.');
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error('At least one transaction is required.');
  }

  const { from, to } = dateRange(transactions);
  const id = statementId || buildStatementId(account, to);
  const currency = (account.currency || '').toUpperCase();
  const bankAccount = account.bankAccount;

  const header = {
    STATEMENTID: id,
    BANKACCOUNT: bankAccount,
    CURRENCY: currency,
    ENDINGBALANCE: round6(closingBalance),
    FROMDATE: formatDateTime(from, false),
    OPENINGBALANCE: round6(openingBalance),
    TODATE: formatDateTime(to, true),
  };

  // Lines are ordered by booking date, keeping CSV order within a date.
  const ordered = transactions
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date - b.t.date || a.i - b.i)
    .map(({ t }) => t);

  const lines = ordered.map((t, index) => ({
    LINENUMBER: index + 1,
    BANKACCOUNT: bankAccount,
    STATEMENTID: id,
    BOOKINGDATE: formatDateTime(t.date, false),
    AMOUNT: round6(t.amount),
    BANKSTATEMENTTRANSACTIONCODE: '',
    COUNTERAMOUNT: 0,
    COUNTERCURRENCY: '',
    COUNTEREXCHANGERATE: 0,
    CREDITORREFERENCEINFORMATION: '',
    DOCUMENTNUMBER: '',
    ENTRYREFERENCE: t.narrative || '',
    INSTRUCTEDAMOUNT: 0,
    INSTRUCTEDCURRENCY: '',
    INSTRUCTEDEXCHANGERATE: 0,
    LINESTATUS: t.lineStatus || 'Booked',
    REFERENCENUMBER: t.reference || '',
    RELATEDBANK: '',
    RELATEDBANKACCOUNT: '',
    REVERSAL: 'No',
    // Credit rows -> the payer (Debtor Name); Debit rows -> the payee (Creditor Name).
    TRADINGPARTY: t.creditDebit === 'Debit' ? t.creditorName || '' : t.debtorName || '',
  }));

  return { statementId: id, header, lines, fromDate: from, toDate: to };
}

/** Digits of the IBAN/account text in the CSV, for the account cross-check. */
function digitsOf(value) {
  return (String(value || '').match(/\d/g) || []).join('');
}

/**
 * Non-fatal checks between the CSV contents and the selected account: does the
 * CSV IBAN belong to this account, and does the CSV currency match?
 */
function crossCheckAccount(account, transactions) {
  const warnings = [];
  const accountCurrency = (account.currency || '').toUpperCase();

  const csvIbans = [...new Set(transactions.map((t) => t.ibanOrAccount).filter(Boolean))];
  if (csvIbans.length > 1) {
    warnings.push(
      `The CSV contains more than one account: ${csvIbans.join(', ')}. ` +
        'All lines will be imported against the selected account.'
    );
  }

  const accountDigits = digitsOf(account.iban) || digitsOf(account.accountNumber);
  for (const iban of csvIbans) {
    const csvDigits = digitsOf(iban);
    const matches =
      accountDigits &&
      csvDigits &&
      (csvDigits === accountDigits ||
        accountDigits.endsWith(csvDigits) ||
        csvDigits.endsWith(accountDigits.slice(-8)));
    if (!matches) {
      warnings.push(
        `The CSV account "${iban}" does not look like the selected account ` +
          `${account.entity} ${account.bankAccount} (${account.iban || account.accountNumber || 'no IBAN on file'}). ` +
          'Check you picked the right account before importing.'
      );
    }
  }

  const csvCurrencies = [...new Set(transactions.map((t) => t.currency).filter(Boolean))];
  for (const ccy of csvCurrencies) {
    if (accountCurrency && ccy !== accountCurrency) {
      warnings.push(
        `The CSV contains ${ccy} transactions but the selected account is ${accountCurrency}. ` +
          `The statement will be created in ${accountCurrency}.`
      );
    }
  }

  return warnings;
}

module.exports = {
  buildStatement,
  buildStatementId,
  validateBalances,
  crossCheckAccount,
  totalAmount,
  dateRange,
  formatDateTime,
  formatDdmmyyyy,
  round6,
  HEADER_COLUMNS,
  LINE_COLUMNS,
  BALANCE_TOLERANCE,
};
