# -*- coding: utf-8 -*-
"""Command line tools used by the back office and by nightly jobs."""
import datetime

from inv_store import open_root, FileStorage
from inv_text import truncate, chf, parse_chf, to_bytes
from inv_search import search_invoices
from inv_report import aging, open_invoices, stats, BUCKETS, CLOSE_DATE
from inv_export import export_ledger
from inv_money import split_installments


def _date(text):
    return datetime.datetime.strptime(text, '%Y-%m-%d').date()


def cmd_list(data, query='', page='1'):
    root = open_root(data)
    hits, total, page, pages = search_invoices(root, query, int(page))
    print '%d invoices, page %d of %d' % (total, page, pages)
    for inv in hits:
        print '  %-13s %-26s %14s  %s' % (inv.id, truncate(inv.customer.name, 26),
                                          chf(inv.total()), inv.status(CLOSE_DATE))


def cmd_show(data, inv_id):
    root = open_root(data)
    inv = root['invoices'][inv_id]
    c = inv.customer
    print '%s  %s' % (inv.id, c.display())
    print '  issued %s, due %s' % (inv.issued.isoformat(), inv.due.isoformat() if inv.due else 'on receipt')
    for l in inv.lines:
        print '  %-34s %6s x %12s = %12s  (VAT %s%%)' % (truncate(l.text, 34), l.qty, chf(l.unit),
                                                       chf(l.net()), l.vat_bp / 100.0)
    print '  net %s  vat %s  total %s' % (chf(inv.net()), chf(inv.vat()), chf(inv.total()))
    if c.skonto_pct:
        print '  %d%% skonto: %s' % (c.skonto_pct, chf(inv.skonto_amount()))
    for when, amount in inv.payments:
        print '  paid %s on %s' % (chf(amount), when.isoformat())
    print '  outstanding %s (%s)' % (chf(inv.outstanding()), inv.status(CLOSE_DATE))


def cmd_customer(data, cust_id):
    root = open_root(data)
    c = root['customers'][cust_id]
    print '%s: %s' % (c.id, c.display())
    print '  tags: %s' % ', '.join(sorted([to_bytes(t) for t in c.tags]))
    mine = sorted([i for i in root['invoices'].values() if i.customer is c], key=lambda i: i.id)
    total = sum([i.outstanding() for i in mine])
    print '  %d invoices, outstanding %s' % (len(mine), chf(total))


def cmd_aging(data, as_of=None):
    root = open_root(data)
    when = _date(as_of) if as_of else CLOSE_DATE
    result = aging(root, when)
    print 'aging at %s' % when.isoformat()
    for b in BUCKETS:
        count, amount = result[b]
        print '  %-8s %3d  %14s' % (b, count, chf(amount))
    print 'open invoices by due date:'
    for inv in open_invoices(root, when):
        print '  %s  %s  %s' % (inv.due.isoformat() if inv.due else 'on receipt', inv.id, chf(inv.outstanding()))


def cmd_stats(data):
    root = open_root(data)
    s = stats(root)
    print 'invoices: %d' % s['count']
    print 'billed: %s' % chf(s['billed'])
    print 'average invoice: %s' % chf(s['average'])
    print 'paid invoices: %d' % s['paid_count']
    print 'average days to pay: %s' % s['avg_days_to_pay']


def cmd_installments(data, inv_id, n):
    root = open_root(data)
    inv = root['invoices'][inv_id]
    for i, amount in enumerate(split_installments(inv.outstanding(), int(n))):
        print '  %d. %s' % (i + 1, chf(amount))


def cmd_export(data, outfile):
    root = open_root(data)
    out = open(outfile, 'wb')
    try:
        export_ledger(root, out)
    finally:
        out.close()
    print 'exported to %s' % outfile


def cmd_pay(data, inv_id, amount, when=None):
    """Records a payment and saves the ledger."""
    storage = FileStorage(data)
    root = storage.load()
    inv = root['invoices'][inv_id]
    paid = parse_chf(amount)
    inv.payments.append((_date(when) if when else CLOSE_DATE, paid))
    storage.save(root)
    print '%s: paid %s, outstanding %s' % (inv.id, chf(paid), chf(inv.outstanding()))


def cmd_seed(data):
    from inv_cli.seed import build_root
    FileStorage(data).save(build_root())
    print 'seeded %s' % data


COMMANDS = {
    'list': cmd_list,
    'show': cmd_show,
    'customer': cmd_customer,
    'aging': cmd_aging,
    'stats': cmd_stats,
    'installments': cmd_installments,
    'export': cmd_export,
    'pay': cmd_pay,
    'seed': cmd_seed,
}
