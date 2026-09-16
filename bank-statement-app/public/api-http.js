'use strict';

/**
 * Talks to the Express back end. The standalone single-file tool swaps this for
 * api-local.js, which runs the same logic in the browser; app.js does not know
 * which one it is using.
 */

window.API = (function () {
  function fail(data, status) {
    const err = new Error((data && data.error) || `Request failed (${status}).`);
    if (data && data.details) err.details = data.details;
    if (data && data.validation) err.validation = data.validation;
    throw err;
  }

  async function json(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(data, res.status);
    return data;
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return json(res);
  }

  return {
    async accounts() {
      const res = await fetch('/api/accounts');
      return (await json(res)).accounts;
    },

    async parseCsv(accountId, file) {
      const form = new FormData();
      form.append('accountId', accountId);
      form.append('file', file);
      const res = await fetch('/api/transactions', { method: 'POST', body: form });
      return json(res);
    },

    verifyBalances(payload) {
      return post('/api/verify-balances', payload);
    },

    async generate(payload) {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) fail(await res.json().catch(() => ({})), res.status);
      return {
        fileName: res.headers.get('X-Statement-File-Name') || 'bank-statement.xlsx',
        blob: await res.blob(),
      };
    },
  };
})();
