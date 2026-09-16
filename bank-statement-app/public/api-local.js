'use strict';

/**
 * Runs every step in the browser, with no server, using the bundled core
 * modules (BankStatementCore). Used by the standalone single-file tool; it
 * exposes the same interface as api-http.js so app.js is unchanged.
 */

window.API = (function () {
  const core = window.BankStatementCore;
  const accountsData = core.accounts;

  function toAppError(err) {
    // AppError from responses.js already carries error/details/validation.
    const out = new Error(err.message);
    if (err.details) out.details = err.details;
    if (err.validation) out.validation = err.validation;
    return out;
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      try {
        resolve(fn());
      } catch (err) {
        reject(toAppError(err));
      }
    });
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`The file "${file.name}" could not be read.`));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsText(file);
    });
  }

  return {
    accounts() {
      return run(() => core.responses.accountsResponse(accountsData));
    },

    async parseCsv(accountId, file) {
      const csvText = await readFile(file);
      return run(() =>
        core.responses.transactionsResponse({
          accounts: accountsData,
          accountId,
          fileName: file.name,
          csvText,
        })
      );
    },

    verifyBalances(payload) {
      return run(() =>
        core.responses.verifyResponse({ accounts: accountsData, ...payload })
      );
    },

    generate(payload) {
      return run(() => {
        const { statement, fileName } = core.responses.prepareStatement({
          accounts: accountsData,
          ...payload,
        });
        const bytes = core.xlsx.renderStatementXlsx(statement);
        return {
          fileName,
          blob: new Blob([bytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
        };
      });
    },
  };
})();
