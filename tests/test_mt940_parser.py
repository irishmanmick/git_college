import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import mt940_parser

SAMPLE_MT940 = """:20:STMT20240115
:21:NONREF
:25:IE29AIBK93115212345678
:28C:00001/001
:60F:C240115EUR10000,00
:61:2401150115D500,00NTRFREF001//BANKREF001
:86:Payment to Supplier A
:61:2401150115C1500,00NTRFINCOMING002//BANKREF002
:86:Customer Payment received
:61:2401160116D250,50NTRFREF003//BANKREF003
:86:Utility Bill Payment
:62F:C240116EUR10749,50"""


def test_parse_transaction_count():
    msg = mt940_parser.parse(SAMPLE_MT940)
    assert len(msg.transactions) == 3


def test_parse_transaction_fields():
    msg = mt940_parser.parse(SAMPLE_MT940)
    tx = msg.transactions[0]
    assert tx.value_date == "240115"
    assert tx.debit_credit == "D"
    assert tx.amount == "500,00"
    assert tx.transaction_type == "NTRF"
    assert tx.customer_ref == "REF001"
    assert tx.bank_ref == "BANKREF001"


def test_parse_86_narrative():
    msg = mt940_parser.parse(SAMPLE_MT940)
    assert msg.transactions[0].raw_86 == ["Payment to Supplier A"]


def test_match_key():
    msg = mt940_parser.parse(SAMPLE_MT940)
    assert msg.transactions[0].match_key == "240115|500,00"


def test_render_with_debtor_name():
    msg = mt940_parser.parse(SAMPLE_MT940)
    msg.transactions[0].debtor_name = "Acme Supplies Ltd"
    rendered = mt940_parser.render(msg)
    assert ":87:Acme Supplies Ltd" in rendered


def test_render_without_debtor_name():
    msg = mt940_parser.parse(SAMPLE_MT940)
    rendered = mt940_parser.render(msg)
    assert ":87:" not in rendered


def test_render_preserves_footer():
    msg = mt940_parser.parse(SAMPLE_MT940)
    rendered = mt940_parser.render(msg)
    assert ":62F:" in rendered
