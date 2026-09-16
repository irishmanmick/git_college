'use strict';

/**
 * Parsing of the bank transactions CSV export.
 *
 * Column names follow the CSV_Column_Reference tab of
 * Kepak_BankStatement_Mapping.xlsx. Headers are matched loosely (case,
 * spacing and punctuation are ignored) so minor export variations still work.
 */

/** Minimal RFC 4180 parser: handles quoted fields, escaped quotes, CRLF. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // handled by the following \n, or ignored for lone CR line endings
      if (text[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** Picks the delimiter used by the header line. */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function normaliseKey(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Template field -> accepted CSV header spellings (normalised on compare). */
const COLUMN_ALIASES = {
  ibanOrAccount: ['Account / IBAN', 'Account/IBAN', 'Account', 'IBAN', 'Account Number'],
  pendingHistorical: [
    'Pending (P) / Historical (H)',
    'Pending / Historical',
    'Pending(P)/Historical(H)',
    'Status',
  ],
  amount: ['Amount', 'Transaction Amount', 'Value'],
  currency: ['Currency', 'CCY', 'Transaction Currency'],
  creditDebit: ['Credit / Debit', 'Credit/Debit', 'Debit / Credit', 'DR/CR', 'Credit or Debit'],
  date: ['Date', 'Booking Date', 'Value Date', 'Transaction Date'],
  narrative: ['Transaction Narrative', 'Narrative', 'Description', 'Details'],
  balance: ['Balance', 'Running Balance'],
  balanceCreditDebit: ['Balance Credit / Debit', 'Balance Credit/Debit', 'Balance DR/CR'],
  reference: ['Transaction Reference', 'Reference', 'Bank Reference', 'End To End Id'],
  creditorName: ['Creditor Name', 'Creditor', 'Payee', 'Payee Name'],
  debtorName: ['Debtor Name', 'Debtor', 'Payer', 'Payer Name'],
};

const REQUIRED_COLUMNS = ['amount', 'creditDebit', 'date'];

const REQUIRED_COLUMN_LABELS = {
  amount: 'Amount',
  creditDebit: 'Credit / Debit',
  date: 'Date',
};

/** Maps each logical field to the index of its column in the header row. */
function mapHeader(headerRow) {
  const normalised = headerRow.map(normaliseKey);
  const indexes = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalised.indexOf(normaliseKey(alias));
      if (idx !== -1) {
        indexes[field] = idx;
        break;
      }
    }
  }
  return indexes;
}

/**
 * Parses an amount written with either a dot or a comma decimal separator and
 * with optional thousands separators, brackets or a leading sign.
 * Returns the absolute magnitude plus whether the source text was negative.
 */
function parseAmount(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (text === '') return { value: null, negative: false };

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[^\d.,+-]/g, '');
  if (text.startsWith('-')) negative = true;
  text = text.replace(/[+-]/g, '');
  // Nothing numeric left (e.g. "abc"): not an amount.
  if (!/\d/.test(text)) return { value: null, negative };

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > lastDot) {
    // 1.234,56 -> comma is the decimal separator
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    // 1,234.56 -> comma is a thousands separator
    text = text.replace(/,/g, '');
  }

  const value = Number(text);
  if (!Number.isFinite(value)) return { value: null, negative };
  return { value: Math.abs(value), negative: negative || value < 0 };
}

/** Parses DD/MM/YYYY (also DD-MM-YYYY, DD.MM.YYYY and YYYY-MM-DD). */
function parseDate(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') return null;

  // The four-digit year alternative comes first so 04/09/2026 is not read as year 20.
  const dayFirst = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    let year = Number(dayFirst[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return buildDate(year, month, day);
  }

  const isoLike = text.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (isoLike) {
    return buildDate(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]));
  }

  return null;
}

function buildDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null; // e.g. 31/02/2026
  }
  return date;
}

/** 'Credit' / 'C' / 'CR' -> 'Credit'; 'Debit' / 'D' / 'DR' -> 'Debit'. */
function parseCreditDebit(raw) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (text === '') return null;
  if (/^c(r|redit)?$/.test(text) || text === 'credit') return 'Credit';
  if (/^d(r|ebit)?$/.test(text) || text === 'debit') return 'Debit';
  return null;
}

/** H -> Booked, P -> Pending (Lines_Mapping, LINESTATUS). Defaults to Booked. */
function parseLineStatus(raw) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase();
  if (text === '') return 'Booked';
  if (text.startsWith('h') || text.startsWith('booked') || text.startsWith('hist')) return 'Booked';
  if (text.startsWith('p')) return 'Pending';
  return 'Booked';
}

/**
 * Parses the CSV text into transactions.
 *
 * @returns {{transactions: Array, errors: string[], warnings: string[], headers: string[], skippedRows: number}}
 */
function parseTransactionsCsv(text) {
  const errors = [];
  const warnings = [];

  const clean = String(text || '').replace(/^﻿/, '');
  if (clean.trim() === '') {
    return { transactions: [], errors: ['The CSV file is empty.'], warnings, headers: [], skippedRows: 0 };
  }

  const rows = parseDelimited(clean, detectDelimiter(clean));
  if (rows.length === 0) {
    return { transactions: [], errors: ['The CSV file has no rows.'], warnings, headers: [], skippedRows: 0 };
  }

  const headers = rows[0].map((h) => String(h).trim());
  const idx = mapHeader(headers);

  const missing = REQUIRED_COLUMNS.filter((f) => idx[f] === undefined);
  if (missing.length > 0) {
    errors.push(
      `The CSV is missing required column(s): ${missing
        .map((f) => REQUIRED_COLUMN_LABELS[f])
        .join(', ')}. Columns found: ${headers.join(', ') || '(none)'}.`
    );
    return { transactions: [], errors, warnings, headers, skippedRows: 0 };
  }

  const get = (row, field) => (idx[field] === undefined ? '' : String(row[idx[field]] ?? '').trim());

  const transactions = [];
  let skippedRows = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 1; // 1-based, counting the header row
    const rowErrors = [];

    const { value: magnitude, negative } = parseAmount(get(row, 'amount'));
    if (magnitude === null) {
      rowErrors.push(`row ${rowNumber}: Amount "${get(row, 'amount')}" is not a number`);
    }

    const date = parseDate(get(row, 'date'));
    if (!date) {
      rowErrors.push(`row ${rowNumber}: Date "${get(row, 'date')}" is not a valid date`);
    }

    let creditDebit = parseCreditDebit(get(row, 'creditDebit'));
    if (!creditDebit) {
      // Fall back to the sign of the amount when the indicator is unusable.
      if (magnitude !== null) {
        creditDebit = negative ? 'Debit' : 'Credit';
        warnings.push(
          `Row ${rowNumber}: Credit / Debit value "${get(row, 'creditDebit')}" not recognised; ` +
            `treated as ${creditDebit} based on the amount sign.`
        );
      } else {
        rowErrors.push(
          `row ${rowNumber}: Credit / Debit value "${get(row, 'creditDebit')}" is not recognised`
        );
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      skippedRows += 1;
      continue;
    }

    transactions.push({
      rowNumber,
      ibanOrAccount: get(row, 'ibanOrAccount'),
      lineStatus: parseLineStatus(get(row, 'pendingHistorical')),
      amount: creditDebit === 'Debit' ? -magnitude : magnitude,
      magnitude,
      currency: get(row, 'currency').toUpperCase(),
      creditDebit,
      date,
      narrative: get(row, 'narrative'),
      balance: parseAmount(get(row, 'balance')).value,
      reference: get(row, 'reference'),
      creditorName: get(row, 'creditorName'),
      debtorName: get(row, 'debtorName'),
    });
  }

  if (transactions.length === 0 && errors.length === 0) {
    errors.push('The CSV contains a header row but no transaction rows.');
  }

  return { transactions, errors, warnings, headers, skippedRows };
}

module.exports = {
  parseTransactionsCsv,
  parseDelimited,
  detectDelimiter,
  parseAmount,
  parseDate,
  parseCreditDebit,
  parseLineStatus,
  mapHeader,
  normaliseKey,
  COLUMN_ALIASES,
};
