'use strict';

/**
 * The application logic behind each step, shaped as the responses the front end
 * consumes. Kept free of Node and DOM dependencies so the Express server and
 * the standalone single-file browser tool both run this exact code.
 *
 * Failures throw an AppError carrying the HTTP status the server should use.
 */

const { parseTransactionsCsv } = require('./csv');
const utils = require('./account-utils');
const {
  buildStatement,
  buildStatementId,
  validateBalances,
  crossCheckAccount,
} = require('./transform');

class AppError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.name = 'AppError';
    this.status = status || 400;
    Object.assign(this, extra || {});
  }
}

/** Accepts "1,234.56", "1.234,56", "(500)" and plain numbers. */
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value == null ? '' : value).trim();
  if (text === '') return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^\d.,+-]/g, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  text = text.replace(/[+]/g, '');
  if (!/\d/.test(text)) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');

  const num = Number(text);
  if (!Number.isFinite(num)) return null;
  return negative ? -num : num;
}

/** Step 1: the accounts a user may reconcile, with display fields added. */
function accountsResponse(accounts) {
  return utils.selectable(accounts).map((a) => ({
    id: a.id,
    entity: a.entity,
    bankAccount: a.bankAccount,
    name: a.name,
    currency: a.currency,
    iban: a.iban,
    accountNumber: a.accountNumber,
    mainAccount: a.mainAccount,
    swift: a.swift,
    label: utils.accountLabel(a),
    statementIdPrefix: utils.statementIdPrefix(a),
  }));
}

function requireAccount(accounts, accountId, message) {
  const account = utils.findById(accounts, accountId);
  if (!account) {
    throw new AppError(message || 'Select an account first.', 400);
  }
  return account;
}

/** Step 2: parse a transactions CSV and summarise what was found. */
function transactionsResponse({ accounts, accountId, fileName, csvText }) {
  const account = requireAccount(
    accounts,
    accountId,
    'Select an account before uploading a CSV file.'
  );

  const parsed = parseTransactionsCsv(csvText);
  if (parsed.transactions.length === 0) {
    throw new AppError('No usable transactions could be read from the CSV file.', 422, {
      details: parsed.errors,
    });
  }

  const warnings = [...parsed.warnings, ...crossCheckAccount(account, parsed.transactions)];
  if (parsed.skippedRows > 0) {
    warnings.unshift(
      `${parsed.skippedRows} row(s) could not be read and were skipped. Fix the CSV and re-upload ` +
        'if those rows belong in the statement.'
    );
  }

  const summary = validateBalances(0, 0, parsed.transactions);
  const times = parsed.transactions.map((t) => t.date.getTime());

  return {
    fileName,
    headers: parsed.headers,
    transactionCount: parsed.transactions.length,
    creditCount: summary.creditCount,
    debitCount: summary.debitCount,
    creditTotal: summary.creditTotal,
    debitTotal: summary.debitTotal,
    transactionTotal: summary.transactionTotal,
    fromDate: isoDay(Math.min(...times)),
    toDate: isoDay(Math.max(...times)),
    rowErrors: parsed.errors,
    warnings,
    transactions: parsed.transactions.map(serialiseTransaction),
  };
}

/** Step 3: check opening + transactions = closing. */
function verifyResponse({ accounts, accountId, openingBalance, closingBalance, transactions }) {
  const account = requireAccount(accounts, accountId);

  const opening = parseNumber(openingBalance);
  const closing = parseNumber(closingBalance);
  if (opening === null || closing === null) {
    throw new AppError(
      'Enter both an opening balance and a closing balance as numbers.',
      400
    );
  }

  const parsedTransactions = deserialiseTransactions(transactions);
  if (parsedTransactions.length === 0) {
    throw new AppError('Upload a transactions CSV first.', 400);
  }

  const result = validateBalances(opening, closing, parsedTransactions);
  const statementDate = new Date(Math.max(...parsedTransactions.map((t) => t.date.getTime())));

  return {
    ...result,
    currency: (account.currency || '').toUpperCase(),
    statementId: buildStatementId(account, statementDate),
    message: result.valid
      ? 'Balances verified: opening balance plus the transaction total equals the closing balance.'
      : 'The balances do not reconcile. Opening balance plus the transaction total does not equal ' +
        'the closing balance, so one of the balances must be wrong. Please re-enter them.',
  };
}

/**
 * Step 4: validate once more, then build the statement. The balance check runs
 * here as well as in step 3, so no caller can produce an unreconciled file.
 */
function prepareStatement({ accounts, accountId, openingBalance, closingBalance, transactions }) {
  const account = requireAccount(accounts, accountId);

  const opening = parseNumber(openingBalance);
  const closing = parseNumber(closingBalance);
  if (opening === null || closing === null) {
    throw new AppError('Enter both an opening balance and a closing balance.', 400);
  }

  const parsedTransactions = deserialiseTransactions(transactions);
  if (parsedTransactions.length === 0) {
    throw new AppError('Upload a transactions CSV first.', 400);
  }

  const check = validateBalances(opening, closing, parsedTransactions);
  if (!check.valid) {
    throw new AppError(
      'The balances do not reconcile, so no file was generated. Opening balance plus the ' +
        'transaction total does not equal the closing balance.',
      422,
      { validation: check }
    );
  }

  const statement = buildStatement({
    account,
    openingBalance: opening,
    closingBalance: closing,
    transactions: parsedTransactions,
  });

  return { statement, fileName: statementFileName(statement.statementId) };
}

/** Sanitises a statement ID for use as a file name. */
function statementFileName(statementId) {
  const safe = String(statementId).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}.xlsx`;
}

function serialiseTransaction(t) {
  return {
    rowNumber: t.rowNumber,
    ibanOrAccount: t.ibanOrAccount,
    lineStatus: t.lineStatus,
    amount: t.amount,
    currency: t.currency,
    creditDebit: t.creditDebit,
    date: isoDay(t.date.getTime()),
    narrative: t.narrative,
    reference: t.reference,
    creditorName: t.creditorName,
    debtorName: t.debtorName,
  };
}

/** Rebuilds transactions handed back by the front end, revalidating each field. */
function deserialiseTransactions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const amount = Number(t && t.amount);
    const date = t && typeof t.date === 'string' ? new Date(`${t.date}T00:00:00Z`) : null;
    if (!Number.isFinite(amount) || !date || Number.isNaN(date.getTime())) continue;
    out.push({
      rowNumber: t.rowNumber,
      ibanOrAccount: str(t.ibanOrAccount),
      lineStatus: t.lineStatus === 'Pending' ? 'Pending' : 'Booked',
      amount,
      currency: str(t.currency).toUpperCase(),
      creditDebit: amount < 0 ? 'Debit' : 'Credit',
      date,
      narrative: str(t.narrative),
      reference: str(t.reference),
      creditorName: str(t.creditorName),
      debtorName: str(t.debtorName),
    });
  }
  return out;
}

function str(value) {
  return value == null ? '' : String(value);
}

function isoDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

module.exports = {
  AppError,
  accountsResponse,
  transactionsResponse,
  verifyResponse,
  prepareStatement,
  statementFileName,
  deserialiseTransactions,
  parseNumber,
};
