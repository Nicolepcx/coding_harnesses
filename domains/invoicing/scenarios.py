"""Frozen acceptance scenarios for the invoicing domain, generated from the
legacy data by coverage, not hand-picked against known traps:
every invoice, every customer, every page, every word in names, cities and
line texts, a range of report dates, installments, payments, the export and
the web routes, plus a fixed list of awkward inputs.

generate(root, items) receives the canonical dump of the legacy store
(see harness/checks/inspect_store.py); items(node) lists a dump dict's pairs.
"""
import re
import urllib.parse

AWKWARD = ["", " ", "a", "%", "<b>&amp;\"'</b>", "x" * 40, "e", "2026", "ü", "-", "INV"]
REPORT_DATES = ["2025-10-31", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30", "2026-13-01"]
PAYMENTS = ["0.05", "100", "1234,50", "-10"]


def generate(root, items):
    tables = dict(items(root))
    invoices, customers, words = [], [], []

    def add_word(w):
        for v in (w, w.lower()):
            if v not in words:
                words.append(v)

    for cid, obj in items(tables["customers"]):
        attrs = dict(items(obj["attrs"]))
        customers.append(cid)
        for w in re.split(r"[\s,&./()\-]+", attrs.get("name", "")) + [attrs.get("city", "")]:
            if len(w) >= 3:
                add_word(w)
    for iid, obj in items(tables["invoices"]):
        attrs = dict(items(obj["attrs"]))
        invoices.append(iid)
        for line in attrs.get("lines", []):
            text = dict(items(line["attrs"])).get("text", "")
            for w in re.split(r"[\s,&./()\-<>«»]+", text):
                if len(w) >= 4:
                    add_word(w)
    invoices.sort()
    customers.sort()
    queries = list(AWKWARD) + [w for w in words if w not in AWKWARD] + invoices[:3]
    pages = -(-len(invoices) // 10) + 2

    sc = []
    for i, q in enumerate(queries):
        sc.append({"id": "cli-list-q%03d" % i, "kind": "cli", "steps": [["list", "{data}", q]]})
        sc.append({"id": "http-list-q%03d" % i, "kind": "http", "path": "/?" + urllib.parse.urlencode({"q": q})})
    for p in range(0, pages + 1):
        sc.append({"id": "cli-list-page%d" % p, "kind": "cli", "steps": [["list", "{data}", "", str(p)]]})
        sc.append({"id": "http-list-page%d" % p, "kind": "http", "path": "/?q=&page=%d" % p})
    sc.append({"id": "http-list-page-text", "kind": "http", "path": "/?q=&page=abc"})
    for iid in invoices:
        sc.append({"id": "cli-show-%s" % iid, "kind": "cli", "steps": [["show", "{data}", iid]]})
        sc.append({"id": "http-invoice-%s" % iid, "kind": "http", "path": "/invoice/" + iid})
    for cid in customers:
        sc.append({"id": "cli-customer-%s" % cid, "kind": "cli", "steps": [["customer", "{data}", cid]]})
        sc.append({"id": "http-customer-%s" % cid, "kind": "http", "path": "/customer/" + cid})
    sc.append({"id": "cli-show-missing", "kind": "cli", "steps": [["show", "{data}", "NOPE"]]})
    sc.append({"id": "http-invoice-missing", "kind": "http", "path": "/invoice/NOPE"})
    sc.append({"id": "http-customer-missing", "kind": "http", "path": "/customer/NOPE"})
    sc.append({"id": "http-unknown-route", "kind": "http", "path": "/admin"})
    sc.append({"id": "cli-aging", "kind": "cli", "steps": [["aging", "{data}"]]})
    for d in REPORT_DATES:
        sc.append({"id": "cli-aging-%s" % d, "kind": "cli", "steps": [["aging", "{data}", d]]})
    sc.append({"id": "http-aging", "kind": "http", "path": "/aging"})
    sc.append({"id": "cli-stats", "kind": "cli", "steps": [["stats", "{data}"]]})
    for iid in invoices[::4]:
        for n in ("1", "2", "3", "7"):
            sc.append({"id": "cli-installments-%s-%s" % (iid, n), "kind": "cli",
                       "steps": [["installments", "{data}", iid, n]]})
    sc.append({"id": "cli-export", "kind": "cli", "steps": [["export", "{data}", "{tmp}/ledger.csv"]],
               "collect": ["ledger.csv"]})
    sc.append({"id": "http-ledger", "kind": "http", "path": "/ledger.csv"})
    for iid in invoices[1::6]:
        for j, amount in enumerate(PAYMENTS):
            sc.append({"id": "cli-pay-%s-%d" % (iid, j), "kind": "cli",
                       "steps": [["pay", "{data}", iid, amount, "2026-07-01"], ["show", "{data}", iid]]})
    sc.append({"id": "cli-usage", "kind": "cli", "steps": [["nonsense", "{data}"]]})
    return sc
