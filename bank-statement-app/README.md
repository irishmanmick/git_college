# Bank Statement Generator (D365 import)

Turns a bank transactions CSV into the Kepak bank statement Excel file that D365
accepts as a bank statement import.

- **Front end:** plain HTML/CSS/JavaScript (`public/`), no build step.
- **Back end:** Node.js + Express (`server.js`, `src/`).
- **Output:** a copy of `data/KepakBankStatementTemplate.xlsx` with the
  `Bank_statement_header` and `Bank_statement_lines` sheets populated, named
  after the statement ID.

## Two ways to run it

**No install:** open `bank-statement-tool.html` — the whole app in one file,
which runs in the browser with no server, no dependencies and no network. Every
step happens locally: the CSV is never uploaded and the Excel file is written by
your browser. Good for trying it out or for a couple of users.

**As a server:**

```bash
cd bank-statement-app
npm install
npm start           # http://localhost:3000   (PORT=8080 npm start to change port)
npm test            # 50 tests, node:test
npm run build:standalone   # regenerate bank-statement-tool.html
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting on Azure, including locking it
behind Entra ID sign-in.

The two versions share all their logic — parsing, mapping, the balance rules and
the account list — so they cannot drift. `bank-statement-tool.html` is generated
from `src/` and `public/` by `npm run build:standalone`; edit those, not the
generated HTML. A test fails if the committed file is stale, and another asserts
that the browser's workbook writer and the server's template writer produce
identical output cell for cell.

## The flow

1. **Pick the account being reconciled.** The list comes from the "List of Bank
   Accounts" tab of `data/Kepak_BankStatement_Mapping.xlsx`, filterable by
   entity. Selecting an account shows its BANKACCOUNT code, currency, IBAN and
   main account so you can confirm before going on.
2. **Upload the transactions CSV.** The app parses it, shows every line it read
   (date, signed amount, Dr/Cr, status, reference, counterparty, narrative) and
   the credit/debit/net totals. It warns — without blocking — if the CSV's IBAN
   or currency does not match the selected account.
3. **Enter the opening and closing balances.** The app checks
   `opening + total of transactions = closing`. If it does not hold, it shows
   the workings and the difference and asks for re-entry. Nothing can be
   generated until the check passes.
4. **Generate.** The populated template downloads as `<STATEMENTID>.xlsx`.

The balance check is re-run server-side in `POST /api/generate`, so the API
cannot be used to produce an unreconciled file.

## Statement ID

Format `BANK-CCY-ACCT-DDMMYYYY`, as recommended in the mapping workbook —
for example `AIB-EUR-7268-04092026`.

| Part       | Source                                                        |
| ---------- | ------------------------------------------------------------- |
| `BANK`     | SWIFT/BIC institution code of the account (`AIBKIE2D` → `AIB`) |
| `CCY`      | Account currency from the account master list                 |
| `ACCT`     | Last four digits of the bank account number (IBAN as fallback) |
| `DDMMYYYY` | **Latest** transaction date in the CSV, i.e. the statement period end date |

The generated file is named `<STATEMENTID>.xlsx`.

## CSV columns

Column names follow the `CSV_Column_Reference` tab. Matching ignores case,
spacing and punctuation, and common alternatives are accepted (e.g. `Narrative`
for `Transaction Narrative`), so small export variations still work.

| CSV column                      | Required | Used for                                   |
| ------------------------------- | -------- | ------------------------------------------ |
| `Amount`                        | yes      | `AMOUNT` (magnitude)                       |
| `Credit / Debit`                | yes      | sign of `AMOUNT`; which name is `TRADINGPARTY` |
| `Date`                          | yes      | `BOOKINGDATE`, `FROMDATE`, `TODATE`        |
| `Account / IBAN`                | no       | cross-check against the selected account   |
| `Currency`                      | no       | cross-check against the account currency   |
| `Transaction Narrative`         | no       | `ENTRYREFERENCE`                           |
| `Transaction Reference`         | no       | `REFERENCENUMBER`                          |
| `Debtor Name`                   | no       | `TRADINGPARTY` on credit rows              |
| `Creditor Name`                 | no       | `TRADINGPARTY` on debit rows               |
| `Pending (P) / Historical (H)`  | no       | `LINESTATUS` (H → Booked, P → Pending; defaults to Booked) |

Dates are read as `DD/MM/YYYY` (also `DD-MM-YYYY`, `DD.MM.YYYY`, `YYYY-MM-DD`).
Amounts accept `1,234.56`, `1.234,56`, `(500)` and leading signs. Rows with an
unreadable amount or date are skipped and listed on screen rather than silently
dropped. `samples/transactions-EUR-DEB-7268.csv` is a worked example (opening
`0`, closing `45348.56`).

## Mapping applied

`Bank_statement_header` — one row:

| Field            | Value                                             |
| ---------------- | ------------------------------------------------- |
| `STATEMENTID`    | generated, see above                              |
| `BANKACCOUNT`    | BANKACCOUNT of the selected account               |
| `CURRENCY`       | currency of the selected account                  |
| `ENDINGBALANCE`  | closing balance entered by the user               |
| `FROMDATE`       | earliest CSV date as `YYYY-MM-DD 00:00:00`        |
| `OPENINGBALANCE` | opening balance entered by the user               |
| `TODATE`         | latest CSV date as `YYYY-MM-DD 23:59:59`          |

`Bank_statement_lines` — one row per transaction, ordered by booking date:

| Field | Value |
| ----- | ----- |
| `LINENUMBER` | sequential from 1 |
| `BANKACCOUNT`, `STATEMENTID` | same as the header |
| `BOOKINGDATE` | CSV `Date` as `YYYY-MM-DD 00:00:00` |
| `AMOUNT` | CSV `Amount`, positive for Credit and negative for Debit |
| `ENTRYREFERENCE` | CSV `Transaction Narrative` |
| `REFERENCENUMBER` | CSV `Transaction Reference` |
| `LINESTATUS` | `Booked` (H) or `Pending` (P) |
| `TRADINGPARTY` | `Debtor Name` on credits, `Creditor Name` on debits |
| `COUNTERAMOUNT`, `INSTRUCTEDAMOUNT` | `0`, formatted to 6 decimals |
| `COUNTEREXCHANGERATE`, `INSTRUCTEDEXCHANGERATE` | `0`, formatted to 16 decimals |
| `REVERSAL` | `No` |
| `BANKSTATEMENTTRANSACTIONCODE`, `COUNTERCURRENCY`, `CREDITORREFERENCEINFORMATION`, `DOCUMENTNUMBER`, `INSTRUCTEDCURRENCY`, `RELATEDBANK`, `RELATEDBANKACCOUNT` | left blank |

Dates are written as text in exactly the format the mapping specifies, rather
than as Excel serial dates. Amounts are written as numbers with a 6-decimal
display format, so D365 receives numeric values.

## API

| Endpoint                   | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `GET /api/accounts`        | selectable accounts                                      |
| `POST /api/transactions`   | multipart upload (`accountId`, `file`); parses the CSV    |
| `POST /api/verify-balances`| checks opening + transactions = closing                  |
| `POST /api/generate`       | re-checks the balances, returns the xlsx                 |

## Data files

| File | Purpose |
| ---- | ------- |
| `data/bank-accounts.json` | account master list, extracted from the mapping workbook |
| `data/KepakBankStatementTemplate.xlsx` | the D365 template; every generated file starts as a copy of this |
| `data/Kepak_BankStatement_Mapping.xlsx` | the source mapping workbook, kept for reference |

Regenerate `bank-accounts.json` after the account list changes in the mapping
workbook, then run `npm run build:standalone` so the single-file version picks
the change up. A test asserts the template's column names still match what the
code writes, so it fails loudly if the template is replaced with a different
layout.

## Layout

| Path | What it is |
| ---- | ---------- |
| `src/csv.js` | CSV parsing |
| `src/transform.js` | the mapping, the statement ID and the balance rules |
| `src/account-utils.js` | account lookups and labels |
| `src/responses.js` | the logic behind each step, shared by both versions |
| `src/workbook.js` | writes into the real template (server, uses exceljs) |
| `src/xlsx-browser.js` | writes xlsx from scratch (browser, no dependencies) |
| `server.js` | Express routes, thin wrappers over `src/responses.js` |
| `public/app.js` | the four-step UI, used by both versions |
| `public/api-http.js` | data access via the server |
| `public/api-local.js` | data access in the browser, no server |
| `tools/build-standalone.js` | assembles `bank-statement-tool.html` |

The single-file version bundles the `src/` modules with a small CommonJS shim,
so they run unmodified in the browser.

## Notes and current limits

- Accounts whose name in the mapping workbook says "MUST BE EXCLUDED" or
  "MUST BE DELETED" (6 of 37) are not offered for selection.
- The balance check tolerance is half a cent (`BALANCE_TOLERANCE` in
  `src/transform.js`).
- Balances are typed by the user rather than read from the CSV `Balance` column,
  which the sample exports leave blank.
- Amounts are summed in integer micro-units, so floating-point drift cannot make
  a reconciling statement look out of balance.
- One statement per CSV. A CSV spanning several accounts is imported against the
  selected account, with a warning.
- Uploads are capped at 10 MB and held in memory only; nothing is written to
  disk server-side. The single-file version does not upload at all.
- The single-file version writes the xlsx itself rather than filling a copy of
  the template, since a browser cannot read `data/` from disk. Entries are
  stored uncompressed, so the file is a little larger than the server's; a test
  asserts the cell contents and number formats are identical.
- No statement history is kept. If you need a record of what was generated and
  by whom, that needs the server version plus somewhere to write to.
- `npm audit` reports a moderate advisory in `uuid`, a transitive dependency of
  `exceljs`. It concerns a buffer bounds check that only applies when a `buf`
  argument is passed to `uuid`, which `exceljs` does not do. The only fix
  available is a downgrade to `exceljs@3`, so it is left as is.
