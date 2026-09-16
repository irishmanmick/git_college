'use strict';

/**
 * Account helpers with no filesystem or DOM dependency, so the same code runs
 * on the server and inside the standalone browser tool.
 */

/**
 * Accounts a user is allowed to reconcile. Rows the mapping file names
 * "MUST BE EXCLUDED" / "MUST BE DELETED" are flagged excluded and hidden.
 */
function selectable(accounts) {
  return accounts.filter((a) => !a.excluded);
}

function findById(accounts, id) {
  return selectable(accounts).find((a) => a.id === id) || null;
}

/**
 * Last 4 digits of the account, used in the statement ID. Prefers the bank
 * account number and falls back to the IBAN.
 */
function accountSuffix(account) {
  const digits = (String(account.accountNumber || '').match(/\d/g) || []).join('');
  if (digits.length >= 4) return digits.slice(-4);
  const ibanDigits = (String(account.iban || '').match(/\d/g) || []).join('');
  if (ibanDigits.length >= 4) return ibanDigits.slice(-4);
  return null;
}

/**
 * Bank code for the statement ID, derived from the first four characters of
 * the SWIFT/BIC (the bank's institution code). AIBKIE2D -> AIB.
 */
function bankCode(account) {
  const swift = String(account.swift || '').toUpperCase();
  if (/^AIBK/.test(swift)) return 'AIB';
  if (swift.length >= 4) return swift.slice(0, 4);
  return 'BANK';
}

/** The "CL · EUR-DEB · EUR — Debtors Account: Euro" picker label. */
function accountLabel(account) {
  return `${account.entity} · ${account.bankAccount} · ${account.currency} — ${account.name}`;
}

/** The BANK-CCY-ACCT part of the statement ID, shown before a CSV is loaded. */
function statementIdPrefix(account) {
  const suffix = accountSuffix(account) || account.bankAccount.replace(/[^A-Za-z0-9]/g, '');
  return `${bankCode(account)}-${(account.currency || '').toUpperCase()}-${suffix}`;
}

module.exports = {
  selectable,
  findById,
  accountSuffix,
  bankCode,
  accountLabel,
  statementIdPrefix,
};
