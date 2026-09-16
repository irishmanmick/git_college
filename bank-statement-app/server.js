'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { selectableAccounts, findAccount, accountSuffix, bankCode } = require('./src/accounts');
const { parseTransactionsCsv } = require('./src/csv');
const {
  buildStatement,
  buildStatementId,
  validateBalances,
  crossCheckAccount,
} = require('./src/transform');
const { renderStatementWorkbook, statementFileName } = require('./src/workbook');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Step 1: the accounts the user can reconcile. */
app.get('/api/accounts', (req, res) => {
  const accounts = selectableAccounts().map((a) => ({
    id: a.id,
    entity: a.entity,
    bankAccount: a.bankAccount,
    name: a.name,
    currency: a.currency,
    iban: a.iban,
    accountNumber: a.accountNumber,
    mainAccount: a.mainAccount,
    swift: a.swift,
    label: `${a.entity} · ${a.bankAccount} · ${a.currency} — ${a.name}`,
    statementIdPrefix: `${bankCode(a)}-${(a.currency || '').toUpperCase()}-${
      accountSuffix(a) || a.bankAccount.replace(/[^A-Za-z0-9]/g, '')
    }`,
  }));
  res.json({ accounts });
});

/** Step 2: parse the transactions CSV and report what was found. */
app.post('/api/transactions', upload.single('file'), (req, res) => {
  const account = findAccount(req.body.accountId);
  if (!account) {
    return res.status(400).json({ error: 'Select an account before uploading a CSV file.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file was uploaded.' });
  }

  const parsed = parseTransactionsCsv(req.file.buffer.toString('utf8'));
  if (parsed.transactions.length === 0) {
    return res.status(422).json({
      error: 'No usable transactions could be read from the CSV file.',
      details: parsed.errors,
    });
  }

  const warnings = [
    ...parsed.warnings,
    ...crossCheckAccount(account, parsed.transactions),
  ];
  if (parsed.skippedRows > 0) {
    warnings.unshift(
      `${parsed.skippedRows} row(s) could not be read and were skipped. Fix the CSV and re-upload ` +
        'if those rows belong in the statement.'
    );
  }

  const summary = validateBalances(0, 0, parsed.transactions);

  res.json({
    fileName: req.file.originalname,
    headers: parsed.headers,
    transactionCount: parsed.transactions.length,
    creditCount: summary.creditCount,
    debitCount: summary.debitCount,
    creditTotal: summary.creditTotal,
    debitTotal: summary.debitTotal,
    transactionTotal: summary.transactionTotal,
    fromDate: isoDate(parsed.transactions, Math.min),
    toDate: isoDate(parsed.transactions, Math.max),
    rowErrors: parsed.errors,
    warnings,
    transactions: parsed.transactions.map(serialiseTransaction),
  });
});

/** Step 3: verify opening + transactions = closing. */
app.post('/api/verify-balances', (req, res) => {
  const account = findAccount(req.body.accountId);
  if (!account) {
    return res.status(400).json({ error: 'Select an account first.' });
  }

  const opening = parseNumber(req.body.openingBalance);
  const closing = parseNumber(req.body.closingBalance);
  if (opening === null || closing === null) {
    return res.status(400).json({
      error: 'Enter both an opening balance and a closing balance as numbers.',
    });
  }

  const transactions = deserialiseTransactions(req.body.transactions);
  if (transactions.length === 0) {
    return res.status(400).json({ error: 'Upload a transactions CSV first.' });
  }

  const result = validateBalances(opening, closing, transactions);
  const statementDate = new Date(Math.max(...transactions.map((t) => t.date.getTime())));

  res.json({
    ...result,
    currency: (account.currency || '').toUpperCase(),
    statementId: buildStatementId(account, statementDate),
    message: result.valid
      ? 'Balances verified: opening balance plus the transaction total equals the closing balance.'
      : 'The balances do not reconcile. Opening balance plus the transaction total does not equal ' +
        'the closing balance, so one of the balances must be wrong. Please re-enter them.',
  });
});

/** Step 4: generate the populated template. */
app.post('/api/generate', async (req, res, next) => {
  try {
    const account = findAccount(req.body.accountId);
    if (!account) {
      return res.status(400).json({ error: 'Select an account first.' });
    }

    const opening = parseNumber(req.body.openingBalance);
    const closing = parseNumber(req.body.closingBalance);
    if (opening === null || closing === null) {
      return res.status(400).json({ error: 'Enter both an opening balance and a closing balance.' });
    }

    const transactions = deserialiseTransactions(req.body.transactions);
    if (transactions.length === 0) {
      return res.status(400).json({ error: 'Upload a transactions CSV first.' });
    }

    // The balance check is re-run here so the API cannot be used to produce an
    // unreconciled statement file.
    const check = validateBalances(opening, closing, transactions);
    if (!check.valid) {
      return res.status(422).json({
        error:
          'The balances do not reconcile, so no file was generated. Opening balance plus the ' +
          'transaction total does not equal the closing balance.',
        validation: check,
      });
    }

    const statement = buildStatement({
      account,
      openingBalance: opening,
      closingBalance: closing,
      transactions,
    });

    const buffer = await renderStatementWorkbook(statement);
    const fileName = statementFileName(statement.statementId);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Statement-Id', statement.statementId);
    res.setHeader('X-Statement-File-Name', fileName);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

function serialiseTransaction(t) {
  return {
    rowNumber: t.rowNumber,
    ibanOrAccount: t.ibanOrAccount,
    lineStatus: t.lineStatus,
    amount: t.amount,
    currency: t.currency,
    creditDebit: t.creditDebit,
    date: t.date.toISOString().slice(0, 10),
    narrative: t.narrative,
    reference: t.reference,
    creditorName: t.creditorName,
    debtorName: t.debtorName,
  };
}

/** Rebuilds transactions posted back by the browser, revalidating each field. */
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

function isoDate(transactions, pick) {
  const time = pick(...transactions.map((t) => t.date.getTime()));
  return new Date(time).toISOString().slice(0, 10);
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

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'The CSV file is larger than the 10 MB limit.' });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Unexpected server error.' });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Bank statement app listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, parseNumber, deserialiseTransactions };
