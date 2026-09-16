'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { allAccounts } = require('./src/accounts');
const {
  accountsResponse,
  transactionsResponse,
  verifyResponse,
  prepareStatement,
  parseNumber,
} = require('./src/responses');
const { renderStatementWorkbook } = require('./src/workbook');

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
  res.json({ accounts: accountsResponse(allAccounts()) });
});

/** Step 2: parse the transactions CSV and report what was found. */
app.post('/api/transactions', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) {
      throw Object.assign(new Error('No CSV file was uploaded.'), { status: 400 });
    }
    res.json(
      transactionsResponse({
        accounts: allAccounts(),
        accountId: req.body.accountId,
        fileName: req.file.originalname,
        csvText: req.file.buffer.toString('utf8'),
      })
    );
  } catch (err) {
    next(err);
  }
});

/** Step 3: verify opening + transactions = closing. */
app.post('/api/verify-balances', (req, res, next) => {
  try {
    res.json(verifyResponse({ accounts: allAccounts(), ...req.body }));
  } catch (err) {
    next(err);
  }
});

/** Step 4: generate the populated template. */
app.post('/api/generate', async (req, res, next) => {
  try {
    const { statement, fileName } = prepareStatement({ accounts: allAccounts(), ...req.body });
    const buffer = await renderStatementWorkbook(statement);

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

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'The CSV file is larger than the 10 MB limit.' });
  }
  if (err && err.status) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    if (err.validation) body.validation = err.validation;
    return res.status(err.status).json(body);
  }
  console.error(err);
  res.status(500).json({ error: (err && err.message) || 'Unexpected server error.' });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Bank statement app listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, parseNumber };
