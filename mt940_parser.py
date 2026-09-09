"""
MT940 SWIFT bank statement parser and writer.

MT940 structure:
  :20:  Transaction Reference Number
  :21:  Related Reference
  :25:  Account Identification
  :28C: Statement/Sequence Number
  :60F: Opening Balance
  :61:  Statement Line (transaction)
  :86:  Information to Account Owner (narrative)
  :62F: Closing Balance
  :64:  Available Balance (optional)
  :65:  Forward Available Balance (optional)

:61: field format:
  YYMMDD[MMDD]<debit/credit indicator><amount><transaction type code><reference>
  Example: 2301150115D1234,56NTRFNONREF//BANK_REF
"""

import re
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class MT940Transaction:
    raw_61: str = ""
    raw_86: list = field(default_factory=list)
    value_date: str = ""          # YYMMDD
    entry_date: str = ""          # MMDD (optional)
    debit_credit: str = ""        # D/C/RD/RC
    amount: str = ""              # e.g. 1234,56
    transaction_type: str = ""    # e.g. NTRF
    customer_ref: str = ""        # reference before //
    bank_ref: str = ""            # reference after //
    debtor_name: Optional[str] = None   # populated from CSV match

    @property
    def amount_decimal(self) -> float:
        """Amount as float, comma is decimal separator in MT940."""
        try:
            return float(self.amount.replace(",", "."))
        except ValueError:
            return 0.0

    @property
    def date_key(self) -> str:
        """YYMMDD value date for matching."""
        return self.value_date

    @property
    def match_key(self) -> str:
        """Composite key used to match against CSV rows."""
        return f"{self.value_date}|{self.amount}"


@dataclass
class MT940Message:
    header_lines: list = field(default_factory=list)   # lines before first :61:
    transactions: list = field(default_factory=list)   # list of MT940Transaction
    footer_lines: list = field(default_factory=list)   # lines from :62F: onward
    raw_text: str = ""


_TAG_RE = re.compile(r"^:(\d{2}[A-Z]?):")

_61_RE = re.compile(
    r"^(?P<value_date>\d{6})"
    r"(?P<entry_date>\d{4})?"
    r"(?P<dc>R?[CD])"
    r"(?P<amount>[\d,]+)"
    r"(?P<type>[A-Z]{4})"
    r"(?P<customer_ref>[^/\n]*)(?://(?P<bank_ref>[^\n]*))?"
)


def _parse_61(line: str) -> dict:
    m = _61_RE.match(line)
    if not m:
        return {}
    return m.groupdict()


def parse(text: str) -> MT940Message:
    """Parse raw MT940 text into an MT940Message."""
    msg = MT940Message(raw_text=text)
    lines = text.splitlines()

    # Split into tagged segments
    segments = []  # list of (tag, [content_lines])
    current_tag = None
    current_lines = []

    for line in lines:
        m = _TAG_RE.match(line)
        if m:
            if current_tag is not None:
                segments.append((current_tag, current_lines))
            current_tag = m.group(1)
            rest = line[len(m.group(0)):]
            current_lines = [rest] if rest else []
        else:
            if current_tag is None:
                # preamble
                segments.append(("__pre__", [line]))
            else:
                current_lines.append(line)

    if current_tag is not None:
        segments.append((current_tag, current_lines))

    # Walk segments to build header / transactions / footer
    in_transactions = False
    in_footer = False
    current_tx: Optional[MT940Transaction] = None

    for tag, content in segments:
        if tag == "__pre__":
            msg.header_lines.extend(content)
            continue

        if tag == "61":
            in_transactions = True
            if current_tx is not None:
                msg.transactions.append(current_tx)
            tx = MT940Transaction()
            tx.raw_61 = "\n".join(content)
            parsed = _parse_61(tx.raw_61)
            tx.value_date = parsed.get("value_date", "")
            tx.entry_date = parsed.get("entry_date") or ""
            tx.debit_credit = parsed.get("dc", "")
            tx.amount = parsed.get("amount", "")
            tx.transaction_type = parsed.get("type", "")
            tx.customer_ref = (parsed.get("customer_ref") or "").strip()
            tx.bank_ref = (parsed.get("bank_ref") or "").strip()
            current_tx = tx
            continue

        if tag == "86" and in_transactions and current_tx is not None:
            current_tx.raw_86 = content
            continue

        if tag in ("62F", "62M", "64", "65", "86") or (
            in_transactions and tag not in ("61", "86")
        ):
            # start of footer
            if current_tx is not None:
                msg.transactions.append(current_tx)
                current_tx = None
            in_footer = True

        if not in_transactions:
            msg.header_lines.append(f":{tag}:" + "\n".join(content))
        else:
            msg.footer_lines.append(f":{tag}:" + "\n".join(content))

    if current_tx is not None:
        msg.transactions.append(current_tx)

    return msg


def render(msg: MT940Message) -> str:
    """Render an MT940Message back to text, including any :87: Debtors Name fields."""
    parts = []

    for h in msg.header_lines:
        parts.append(h)

    for tx in msg.transactions:
        parts.append(f":61:{tx.raw_61}")
        if tx.raw_86:
            parts.append(":86:" + "\n".join(tx.raw_86))
        if tx.debtor_name:
            parts.append(f":87:{tx.debtor_name}")

    for f_line in msg.footer_lines:
        parts.append(f_line)

    return "\n".join(parts)
