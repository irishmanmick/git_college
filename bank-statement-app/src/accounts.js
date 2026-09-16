'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'bank-accounts.json');

let cache = null;

/**
 * The full account master list, as extracted from the
 * "List of Bank Accounts" tab of Kepak_BankStatement_Mapping.xlsx.
 */
function allAccounts() {
  if (!cache) {
    cache = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  }
  return cache;
}

/**
 * Accounts a user is allowed to reconcile. Rows the mapping file names
 * "MUST BE EXCLUDED" / "MUST BE DELETED" are flagged excluded and hidden.
 */
function selectableAccounts() {
  return allAccounts().filter((a) => !a.excluded);
}

function findAccount(id) {
  return selectableAccounts().find((a) => a.id === id) || null;
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

module.exports = {
  allAccounts,
  selectableAccounts,
  findAccount,
  accountSuffix,
  bankCode,
  ACCOUNTS_FILE,
};
