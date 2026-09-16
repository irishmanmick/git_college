'use strict';

/* Front end for the bank statement generator. Drives the four steps and talks
   to the JavaScript back end over /api. */

const state = {
  accounts: [],
  account: null,
  transactions: [],
  csv: null,
  balances: null,
  verified: false,
};

const $ = (id) => document.getElementById(id);

const el = {
  entityFilter: $('entity-filter'),
  accountSelect: $('account-select'),
  accountCard: $('account-card'),
  accountNext: $('account-next'),
  csvInput: $('csv-input'),
  csvSummary: $('csv-summary'),
  csvNext: $('csv-next'),
  balanceForm: $('balance-form'),
  opening: $('opening-balance'),
  closing: $('closing-balance'),
  balanceResult: $('balance-result'),
  generateSummary: $('generate-summary'),
  generateButton: $('generate-button'),
  generateResult: $('generate-result'),
  stepIndicator: $('step-indicator'),
};

/* ---------------------------------------------------------------- helpers */

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function money(value, currency) {
  const num = Number(value || 0);
  const text = num.toLocaleString('en-IE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${text} ${currency}` : text;
}

function notice(kind, title, body) {
  return `<div class="notice ${kind}">${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${body}</div>`;
}

function list(items) {
  if (!items || items.length === 0) return '';
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function showStep(step) {
  for (let i = 1; i <= 4; i += 1) {
    $(`panel-${i}`).classList.toggle('hidden', i !== step);
  }
  el.stepIndicator.querySelectorAll('li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('current', n === step);
    li.classList.toggle('done', n < step);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.data = data;
    throw err;
  }
  return data;
}

/* --------------------------------------------------------- step 1: account */

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    state.accounts = data.accounts || [];
  } catch (err) {
    el.accountCard.classList.remove('hidden');
    el.accountCard.innerHTML = notice(
      'bad',
      'Could not load the account list',
      `<p>${escapeHtml(err.message)}</p>`
    );
    return;
  }

  const entities = [...new Set(state.accounts.map((a) => a.entity).filter(Boolean))].sort();
  el.entityFilter.insertAdjacentHTML(
    'beforeend',
    entities.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('')
  );
  renderAccountOptions();
}

function renderAccountOptions() {
  const filter = el.entityFilter.value;
  const accounts = filter ? state.accounts.filter((a) => a.entity === filter) : state.accounts;
  el.accountSelect.innerHTML = accounts
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.label)}</option>`)
    .join('');
  el.accountSelect.value = state.account && accounts.includes(state.account) ? state.account.id : '';
  onAccountChange();
}

function onAccountChange() {
  const id = el.accountSelect.value;
  state.account = state.accounts.find((a) => a.id === id) || null;
  el.accountNext.disabled = !state.account;

  if (!state.account) {
    el.accountCard.classList.add('hidden');
    return;
  }

  const a = state.account;
  el.accountCard.classList.remove('hidden');
  el.accountCard.innerHTML = `
    <dl class="kv">
      <dt>Entity</dt><dd>${escapeHtml(a.entity || '—')}</dd>
      <dt>BANKACCOUNT</dt><dd>${escapeHtml(a.bankAccount)}</dd>
      <dt>Name</dt><dd>${escapeHtml(a.name || '—')}</dd>
      <dt>Currency</dt><dd>${escapeHtml(a.currency || '—')}</dd>
      <dt>IBAN</dt><dd class="num">${escapeHtml(a.iban || '—')}</dd>
      <dt>Account number</dt><dd class="num">${escapeHtml(a.accountNumber || '—')}</dd>
      <dt>Main account</dt><dd class="num">${escapeHtml(a.mainAccount || '—')}</dd>
      <dt>Statement ID</dt><dd class="num">${escapeHtml(a.statementIdPrefix)}-DDMMYYYY</dd>
    </dl>`;

  // Changing account invalidates anything captured later.
  resetFromStep2();
}

function resetFromStep2() {
  state.transactions = [];
  state.csv = null;
  resetVerification();
  el.csvSummary.innerHTML = '';
  el.csvNext.disabled = true;
}

function resetVerification() {
  state.verified = false;
  state.balances = null;
  el.balanceResult.innerHTML = '';
  el.generateResult.innerHTML = '';
}

/* ----------------------------------------------------------- step 2: CSV */

async function uploadCsv(file) {
  el.csvSummary.innerHTML = notice('info', '', '<p>Reading the CSV file…</p>');
  el.csvNext.disabled = true;

  const form = new FormData();
  form.append('accountId', state.account.id);
  form.append('file', file);

  let data;
  try {
    const res = await fetch('/api/transactions', { method: 'POST', body: form });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.csvSummary.innerHTML = notice(
        'bad',
        data.error || 'The CSV file could not be read.',
        list(data.details || [])
      );
      return;
    }
  } catch (err) {
    el.csvSummary.innerHTML = notice('bad', 'Upload failed', `<p>${escapeHtml(err.message)}</p>`);
    return;
  }

  state.csv = data;
  state.transactions = data.transactions;
  resetVerification();
  el.csvNext.disabled = false;
  renderCsvSummary(data);
}

function renderCsvSummary(data) {
  const ccy = state.account.currency;
  const blocks = [];

  blocks.push(`
    <div class="summary-grid">
      <dl class="kv">
        <dt>File</dt><dd>${escapeHtml(data.fileName)}</dd>
        <dt>Transactions</dt><dd class="num">${data.transactionCount}</dd>
        <dt>Credits</dt><dd class="num">${data.creditCount} · ${escapeHtml(money(data.creditTotal, ccy))}</dd>
        <dt>Debits</dt><dd class="num">${data.debitCount} · ${escapeHtml(money(data.debitTotal, ccy))}</dd>
        <dt>Net movement</dt><dd class="num">${escapeHtml(money(data.transactionTotal, ccy))}</dd>
        <dt>Date range</dt><dd class="num">${escapeHtml(data.fromDate)} to ${escapeHtml(data.toDate)}</dd>
      </dl>
    </div>`);

  if (data.rowErrors && data.rowErrors.length > 0) {
    blocks.push(
      notice('bad', 'Some rows could not be read and were skipped', list(data.rowErrors))
    );
  }
  if (data.warnings && data.warnings.length > 0) {
    blocks.push(notice('warn', 'Check these before you continue', list(data.warnings)));
  }

  blocks.push(`
    <div class="table-scroll">
      <table class="txns">
        <thead>
          <tr>
            <th>#</th><th>Date</th><th class="right">Amount</th><th>Dr/Cr</th>
            <th>Status</th><th>Reference</th><th>Counterparty</th><th>Narrative</th>
          </tr>
        </thead>
        <tbody>
          ${data.transactions
            .map(
              (t, i) => `
            <tr>
              <td class="num">${i + 1}</td>
              <td class="num">${escapeHtml(t.date)}</td>
              <td class="num right ${t.amount < 0 ? 'debit' : ''}">${escapeHtml(money(t.amount))}</td>
              <td>${escapeHtml(t.creditDebit)}</td>
              <td>${escapeHtml(t.lineStatus)}</td>
              <td class="num">${escapeHtml(t.reference || '')}</td>
              <td>${escapeHtml(t.creditDebit === 'Debit' ? t.creditorName : t.debtorName)}</td>
              <td>${escapeHtml(t.narrative || '')}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`);

  el.csvSummary.innerHTML = blocks.join('');
}

/* ------------------------------------------------------ step 3: balances */

async function verifyBalances(event) {
  event.preventDefault();
  el.opening.classList.remove('invalid');
  el.closing.classList.remove('invalid');

  if (el.opening.value.trim() === '' || el.closing.value.trim() === '') {
    if (el.opening.value.trim() === '') el.opening.classList.add('invalid');
    if (el.closing.value.trim() === '') el.closing.classList.add('invalid');
    el.balanceResult.innerHTML = notice(
      'bad',
      'Both balances are required',
      '<p>Enter the opening balance and the closing balance from the bank statement.</p>'
    );
    return;
  }

  let data;
  try {
    data = await postJson('/api/verify-balances', {
      accountId: state.account.id,
      openingBalance: el.opening.value,
      closingBalance: el.closing.value,
      transactions: state.transactions,
    });
  } catch (err) {
    el.balanceResult.innerHTML = notice(
      'bad',
      'Balances could not be verified',
      `<p>${escapeHtml(err.message)}</p>`
    );
    return;
  }

  const ccy = data.currency;
  const workings = `
    <dl class="kv">
      <dt>Opening balance</dt><dd class="num">${escapeHtml(money(data.openingBalance, ccy))}</dd>
      <dt>Transactions (${data.transactionCount})</dt><dd class="num">${escapeHtml(money(data.transactionTotal, ccy))}</dd>
      <dt>Expected closing</dt><dd class="num">${escapeHtml(money(data.expectedClosingBalance, ccy))}</dd>
      <dt>Closing balance entered</dt><dd class="num">${escapeHtml(money(data.closingBalance, ccy))}</dd>
      <dt>Difference</dt><dd class="num">${escapeHtml(money(data.difference, ccy))}</dd>
    </dl>`;

  if (!data.valid) {
    state.verified = false;
    state.balances = null;
    el.opening.classList.add('invalid');
    el.closing.classList.add('invalid');
    el.balanceResult.innerHTML = notice(
      'bad',
      'The balances do not reconcile',
      `<p>${escapeHtml(data.message)}</p>${workings}`
    );
    return;
  }

  state.verified = true;
  state.balances = {
    openingBalance: data.openingBalance,
    closingBalance: data.closingBalance,
    statementId: data.statementId,
    currency: ccy,
    validation: data,
  };
  el.balanceResult.innerHTML =
    notice('ok', 'Balances verified', `<p>${escapeHtml(data.message)}</p>${workings}`) +
    '<div class="actions"><button type="button" class="primary" id="to-generate">' +
    'Continue to generate the file</button></div>';
  $('to-generate').addEventListener('click', () => {
    renderGenerateSummary();
    showStep(4);
  });
}

/* ------------------------------------------------------ step 4: generate */

function renderGenerateSummary() {
  const a = state.account;
  const b = state.balances;
  el.generateSummary.innerHTML = `
    <div class="summary-grid">
      <dl class="kv">
        <dt>Statement ID / file name</dt>
        <dd><span class="statement-id">${escapeHtml(b.statementId)}</span>.xlsx</dd>
        <dt>Account</dt><dd>${escapeHtml(a.entity)} · ${escapeHtml(a.bankAccount)} — ${escapeHtml(a.name)}</dd>
        <dt>Currency</dt><dd>${escapeHtml(b.currency)}</dd>
        <dt>Period</dt><dd class="num">${escapeHtml(state.csv.fromDate)} to ${escapeHtml(state.csv.toDate)}</dd>
        <dt>Opening balance</dt><dd class="num">${escapeHtml(money(b.openingBalance, b.currency))}</dd>
        <dt>Closing balance</dt><dd class="num">${escapeHtml(money(b.closingBalance, b.currency))}</dd>
        <dt>Statement lines</dt><dd class="num">${state.transactions.length}</dd>
      </dl>
    </div>
    ${notice(
      'info',
      '',
      '<p>The file is built from the Kepak bank statement template, with the ' +
        '<code>Bank_statement_header</code> and <code>Bank_statement_lines</code> sheets populated ' +
        'ready for upload to D365.</p>'
    )}`;
}

async function generateFile() {
  if (!state.verified) {
    el.generateResult.innerHTML = notice(
      'bad',
      'Balances are not verified',
      '<p>Go back and verify the opening and closing balances first.</p>'
    );
    return;
  }

  el.generateButton.disabled = true;
  el.generateResult.innerHTML = notice('info', '', '<p>Generating the Excel file…</p>');

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: state.account.id,
        openingBalance: state.balances.openingBalance,
        closingBalance: state.balances.closingBalance,
        transactions: state.transactions,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      el.generateResult.innerHTML = notice(
        'bad',
        'The file could not be generated',
        `<p>${escapeHtml(data.error || `Request failed (${res.status}).`)}</p>`
      );
      return;
    }

    const fileName = res.headers.get('X-Statement-File-Name') || `${state.balances.statementId}.xlsx`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    el.generateResult.innerHTML = notice(
      'ok',
      'File generated',
      `<p><span class="statement-id">${escapeHtml(fileName)}</span> has been downloaded. ` +
        'Upload it to D365 as the bank statement import for this account.</p>'
    );
  } catch (err) {
    el.generateResult.innerHTML = notice(
      'bad',
      'The file could not be generated',
      `<p>${escapeHtml(err.message)}</p>`
    );
  } finally {
    el.generateButton.disabled = false;
  }
}

function restart() {
  state.account = null;
  el.entityFilter.value = '';
  renderAccountOptions();
  resetFromStep2();
  el.csvInput.value = '';
  el.opening.value = '';
  el.closing.value = '';
  el.opening.classList.remove('invalid');
  el.closing.classList.remove('invalid');
  showStep(1);
}

/* --------------------------------------------------------------- wiring */

el.entityFilter.addEventListener('change', renderAccountOptions);
el.accountSelect.addEventListener('change', onAccountChange);
el.accountSelect.addEventListener('dblclick', () => {
  if (state.account) showStep(2);
});
el.accountNext.addEventListener('click', () => showStep(2));
$('back-to-1').addEventListener('click', () => showStep(1));
$('back-to-2').addEventListener('click', () => showStep(2));
$('back-to-3').addEventListener('click', () => showStep(3));
el.csvNext.addEventListener('click', () => showStep(3));
el.csvInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) uploadCsv(file);
});
el.balanceForm.addEventListener('submit', verifyBalances);
[el.opening, el.closing].forEach((input) =>
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    if (state.verified) resetVerification();
  })
);
el.generateButton.addEventListener('click', generateFile);
$('restart-button').addEventListener('click', restart);

loadAccounts();
