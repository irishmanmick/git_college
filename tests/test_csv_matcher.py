import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import mt940_parser
import csv_matcher

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

SAMPLE_CSV = """Value Date,Amount,Debtor Name,Reference
15/01/2024,500.00,Acme Supplies Ltd,REF001
15/01/2024,1500.00,Global Corp PLC,INCOMING002
16/01/2024,250.50,ESB Energy,REF003
"""

SAMPLE_CSV_NO_MATCH = """Value Date,Amount,Debtor Name,Reference
15/01/2024,999.99,Nobody Here,NOREF
"""


def test_build_lookup_basic():
    lookup = csv_matcher.build_lookup(SAMPLE_CSV)
    assert "240115|500,00" in lookup
    assert lookup["240115|500,00"] == "Acme Supplies Ltd"
    assert lookup["240115|1500,00"] == "Global Corp PLC"


def test_match_all_three():
    msg = mt940_parser.parse(SAMPLE_MT940)
    stats = csv_matcher.match_transactions(msg, SAMPLE_CSV)
    assert stats["matched"] == 3
    assert stats["unmatched"] == 0
    assert stats["total"] == 3


def test_debtor_names_set():
    msg = mt940_parser.parse(SAMPLE_MT940)
    csv_matcher.match_transactions(msg, SAMPLE_CSV)
    assert msg.transactions[0].debtor_name == "Acme Supplies Ltd"
    assert msg.transactions[1].debtor_name == "Global Corp PLC"
    assert msg.transactions[2].debtor_name == "ESB Energy"


def test_no_match():
    msg = mt940_parser.parse(SAMPLE_MT940)
    stats = csv_matcher.match_transactions(msg, SAMPLE_CSV_NO_MATCH)
    assert stats["matched"] == 0
    assert stats["unmatched"] == 3


def test_missing_column_raises():
    bad_csv = "Col1,Col2\nval1,val2\n"
    try:
        csv_matcher.build_lookup(bad_csv)
        assert False, "Should have raised ValueError"
    except ValueError as e:
        assert "Could not identify required CSV columns" in str(e)


def test_date_format_variants():
    csv_iso = "Value Date,Amount,Debtor Name\n2024-01-15,500.00,ISO Format Co\n"
    lookup = csv_matcher.build_lookup(csv_iso)
    assert "240115|500,00" in lookup


def test_bom_handling():
    csv_bom = "﻿Value Date,Amount,Debtor Name\n15/01/2024,500.00,BOM Corp\n"
    lookup = csv_matcher.build_lookup(csv_bom)
    assert "240115|500,00" in lookup
