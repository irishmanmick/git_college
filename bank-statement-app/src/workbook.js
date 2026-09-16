'use strict';

/**
 * Writes the statement into a copy of KepakBankStatementTemplate.xlsx, so the
 * generated file keeps the exact sheet names and column order D365 expects.
 */

const path = require('path');
const ExcelJS = require('exceljs');

const { HEADER_COLUMNS, LINE_COLUMNS } = require('./transform');

const TEMPLATE_FILE = path.join(__dirname, '..', 'data', 'KepakBankStatementTemplate.xlsx');
const HEADER_SHEET = 'Bank_statement_header';
const LINES_SHEET = 'Bank_statement_lines';

const AMOUNT_FORMAT = '0.000000';
const RATE_FORMAT = '0.0000000000000000';

const HEADER_AMOUNT_FIELDS = new Set(['ENDINGBALANCE', 'OPENINGBALANCE']);
const LINE_AMOUNT_FIELDS = new Set(['AMOUNT', 'COUNTERAMOUNT', 'INSTRUCTEDAMOUNT']);
const LINE_RATE_FIELDS = new Set(['COUNTEREXCHANGERATE', 'INSTRUCTEDEXCHANGERATE']);

/** Reads the header row of a sheet, so the template's own order is authoritative. */
function readHeaderRow(sheet) {
  const row = sheet.getRow(1);
  const names = [];
  row.eachCell({ includeEmpty: false }, (cell) => {
    names.push(String(cell.value == null ? '' : cell.value).trim());
  });
  return names;
}

function writeRow(sheet, rowIndex, columns, record, amountFields, rateFields) {
  const row = sheet.getRow(rowIndex);
  columns.forEach((column, i) => {
    const cell = row.getCell(i + 1);
    const value = record[column];

    if (value === '' || value === null || value === undefined) {
      cell.value = null;
      return;
    }

    if (amountFields.has(column)) {
      cell.value = Number(value);
      cell.numFmt = AMOUNT_FORMAT;
    } else if (rateFields.has(column)) {
      cell.value = Number(value);
      cell.numFmt = RATE_FORMAT;
    } else if (typeof value === 'number') {
      cell.value = value;
    } else {
      // Dates are written as text in the exact YYYY-MM-DD HH:MM:SS form the
      // mapping specifies, rather than as Excel serial dates.
      cell.value = String(value);
    }
  });
  row.commit();
}

/**
 * Renders the statement to an xlsx buffer.
 *
 * @param {{header: object, lines: object[]}} statement
 * @returns {Promise<Buffer>}
 */
async function renderStatementWorkbook(statement) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_FILE);

  const headerSheet = workbook.getWorksheet(HEADER_SHEET);
  const linesSheet = workbook.getWorksheet(LINES_SHEET);
  if (!headerSheet || !linesSheet) {
    throw new Error(
      `The template is missing the "${HEADER_SHEET}" or "${LINES_SHEET}" sheet.`
    );
  }

  const headerColumns = readHeaderRow(headerSheet);
  const lineColumns = readHeaderRow(linesSheet);

  assertColumns(HEADER_SHEET, headerColumns, HEADER_COLUMNS);
  assertColumns(LINES_SHEET, lineColumns, LINE_COLUMNS);

  writeRow(headerSheet, 2, headerColumns, statement.header, HEADER_AMOUNT_FIELDS, new Set());

  statement.lines.forEach((line, i) => {
    writeRow(linesSheet, i + 2, lineColumns, line, LINE_AMOUNT_FIELDS, LINE_RATE_FIELDS);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function assertColumns(sheetName, actual, expected) {
  const same =
    actual.length === expected.length && actual.every((name, i) => name === expected[i]);
  if (!same) {
    throw new Error(
      `The template sheet "${sheetName}" does not have the expected columns.\n` +
        `Expected: ${expected.join(', ')}\nFound: ${actual.join(', ')}`
    );
  }
}

module.exports = {
  renderStatementWorkbook,
  readHeaderRow,
  TEMPLATE_FILE,
  HEADER_SHEET,
  LINES_SHEET,
};
