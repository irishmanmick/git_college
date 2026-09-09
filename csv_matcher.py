"""
CSV to MT940 transaction matcher.

Reads a bank CSV export and matches rows to MT940 transactions by:
  1. Value date (YYMMDD from MT940, converted from CSV date column)
  2. Amount (absolute value, comma/dot normalised)

Returns a mapping of MT940 match_key -> debtor_name.

The CSV column names are configurable because every bank exports slightly
different headers.  Defaults cover common AIB / Bank of Ireland layouts.
"""

import csv
import io
import re
from datetime import datetime
from typing import Dict, Optional


DEFAULT_DATE_COLUMNS = ["Value Date", "Date", "Transaction Date", "Txn Date"]
DEFAULT_AMOUNT_COLUMNS = ["Amount", "Debit", "Credit", "Txn Amount"]
DEFAULT_DEBTOR_COLUMNS = ["Debtor Name", "Payee", "Description", "Counterparty", "Narrative"]


def _normalise_amount(value: str) -> str:
    """Return amount as 'NNNN,NN' (MT940 comma-decimal, no thousands separator)."""
    v = value.strip().replace(" ", "").replace("−", "-").lstrip("-")
    # Handle European format: if comma precedes exactly 2 digits at end, it is decimal
    if re.match(r"^\d{1,3}(\.\d{3})*,\d{2}$", v):
        v = v.replace(".", "").replace(",", ".")
    else:
        v = v.replace(",", ".")
    try:
        f = float(v)
        # MT940 format: no thousands sep, comma as decimal
        return f"{f:.2f}".replace(".", ",")
    except ValueError:
        return v


def _parse_date(value: str) -> Optional[str]:
    """Return YYMMDD string from various date formats."""
    value = value.strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%m/%d/%Y", "%d/%m/%y"):
        try:
            dt = datetime.strptime(value, fmt)
            return dt.strftime("%y%m%d")
        except ValueError:
            continue
    return None


def _find_column(headers: list, candidates: list) -> Optional[str]:
    """Case-insensitive column name lookup."""
    lower_map = {h.strip().lower(): h for h in headers}
    for c in candidates:
        if c.strip().lower() in lower_map:
            return lower_map[c.strip().lower()]
    return None


def build_lookup(
    csv_text: str,
    date_columns: list = None,
    amount_columns: list = None,
    debtor_columns: list = None,
) -> Dict[str, str]:
    """
    Parse CSV and return {match_key: debtor_name}.

    match_key format mirrors MT940Transaction.match_key: "YYMMDD|NNNN,NN"
    """
    date_columns = date_columns or DEFAULT_DATE_COLUMNS
    amount_columns = amount_columns or DEFAULT_AMOUNT_COLUMNS
    debtor_columns = debtor_columns or DEFAULT_DEBTOR_COLUMNS

    csv_text = csv_text.lstrip("﻿")   # strip UTF-8 BOM if present
    reader = csv.DictReader(io.StringIO(csv_text))
    headers = reader.fieldnames or []

    date_col = _find_column(headers, date_columns)
    amount_col = _find_column(headers, amount_columns)
    debtor_col = _find_column(headers, debtor_columns)

    if not date_col or not amount_col or not debtor_col:
        missing = []
        if not date_col:
            missing.append(f"date (tried: {date_columns})")
        if not amount_col:
            missing.append(f"amount (tried: {amount_columns})")
        if not debtor_col:
            missing.append(f"debtor name (tried: {debtor_columns})")
        raise ValueError(
            f"Could not identify required CSV columns. Missing: {', '.join(missing)}. "
            f"Available columns: {list(headers)}"
        )

    lookup: Dict[str, str] = {}
    for row in reader:
        raw_date = row.get(date_col, "").strip()
        raw_amount = row.get(amount_col, "").strip()
        debtor = row.get(debtor_col, "").strip()

        if not raw_date or not raw_amount:
            continue

        yymmdd = _parse_date(raw_date)
        if not yymmdd:
            continue

        norm_amount = _normalise_amount(raw_amount)
        key = f"{yymmdd}|{norm_amount}"
        if debtor:
            lookup[key] = debtor

    return lookup


def match_transactions(mt940_msg, csv_text: str, column_map: dict = None) -> dict:
    """
    Match CSV rows to MT940 transactions.

    Returns stats: {matched: int, unmatched: int, total: int}
    Modifies mt940_msg.transactions in place (sets debtor_name).
    """
    column_map = column_map or {}
    lookup = build_lookup(
        csv_text,
        date_columns=column_map.get("date_columns", DEFAULT_DATE_COLUMNS),
        amount_columns=column_map.get("amount_columns", DEFAULT_AMOUNT_COLUMNS),
        debtor_columns=column_map.get("debtor_columns", DEFAULT_DEBTOR_COLUMNS),
    )

    matched = 0
    for tx in mt940_msg.transactions:
        debtor = lookup.get(tx.match_key)
        if debtor:
            tx.debtor_name = debtor
            matched += 1

    total = len(mt940_msg.transactions)
    return {"matched": matched, "unmatched": total - matched, "total": total}
