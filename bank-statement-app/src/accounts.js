'use strict';

const fs = require('fs');
const path = require('path');

const utils = require('./account-utils');

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

function selectableAccounts() {
  return utils.selectable(allAccounts());
}

function findAccount(id) {
  return utils.findById(allAccounts(), id);
}

module.exports = {
  allAccounts,
  selectableAccounts,
  findAccount,
  accountSuffix: utils.accountSuffix,
  bankCode: utils.bankCode,
  accountLabel: utils.accountLabel,
  statementIdPrefix: utils.statementIdPrefix,
  ACCOUNTS_FILE,
};
