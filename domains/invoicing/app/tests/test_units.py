# -*- coding: utf-8 -*-
"""The project's own unit tests: what the team (and any agent) can see.

Like most legacy suites they pass and look reasonable, but they use ASCII
data, round numbers and fresh in-process data files.
"""
import datetime
import os
import tempfile
import unittest
import cStringIO

from inv_text import fold, chf, thousands, parse_chf
from inv_money import vat_of, skonto, split_installments
from inv_paging import page_count, page_slice
from inv_model import Customer, Invoice, Line
from inv_store import FileStorage
from inv_search import search_invoices
from inv_export import export_ledger
from inv_cli.seed import build_root


class TextTest(unittest.TestCase):

    def test_fold_ascii(self):
        self.assertEqual(fold('Zurich'), 'zurich')

    def test_thousands(self):
        self.assertEqual(thousands(1234567), "1'234'567")

    def test_chf(self):
        self.assertEqual(chf(123450), "CHF 1'234.50")

    def test_parse_chf(self):
        self.assertEqual(parse_chf('12.30'), 1230)


class MoneyTest(unittest.TestCase):

    def test_vat_standard(self):
        self.assertEqual(vat_of(10000, 810), 810)

    def test_skonto(self):
        self.assertEqual(skonto(10000, 2), 200)

    def test_installments(self):
        self.assertEqual(split_installments(900, 3), [300, 300, 300])


class PagingTest(unittest.TestCase):

    def test_page_count_exact(self):
        self.assertEqual(page_count(20, 10), 2)

    def test_page_slice(self):
        self.assertEqual(page_slice(range(25), 3, 10), [20, 21, 22, 23, 24])


class ModelTest(unittest.TestCase):

    def test_invoice_total(self):
        c = Customer('X1', 'ACME', 'Bern', 'a@b.c')
        inv = Invoice('I1', c, datetime.date(2026, 1, 1), None, [Line('Work', 2, 10000, 810)])
        self.assertEqual(inv.total(), 21620)


class StoreTest(unittest.TestCase):

    def test_roundtrip(self):
        path = os.path.join(tempfile.mkdtemp(), 'test.fs')
        FileStorage(path).save(build_root())
        root = FileStorage(path).load()
        self.assertEqual(len(root['invoices']), 24)


class SearchTest(unittest.TestCase):

    def test_search_ascii(self):
        hits, total, page, pages = search_invoices(build_root(), 'Spital')
        self.assertEqual(total, 4)


class ExportTest(unittest.TestCase):

    def test_export_has_all_rows(self):
        buf = cStringIO.StringIO()
        export_ledger(build_root(), buf)
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 25)
        self.assertTrue('invoice' in lines[0])


if __name__ == '__main__':
    unittest.main()
