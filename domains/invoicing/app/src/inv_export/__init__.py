"""Ledger export for the accounting software.

The accounting software imports this file every night. Its format (column
order, separator, encoding) has not changed since 2011 and must not change.
"""
import csv



def _cp1252(value):
    if isinstance(value, str):
        return value.decode('utf-8').encode('cp1252', 'replace')
    if isinstance(value, unicode):
        return value.encode('cp1252', 'replace')
    return str(value)


def _amount(rappen):
    return '%d.%02d' % (rappen / 100, rappen % 100)


def ledger_rows(root):
    rows = []
    for inv in sorted(root['invoices'].values(), key=lambda i: i.id):
        rows.append({
            'date': inv.issued.isoformat(),
            'invoice': inv.id,
            'customer': inv.customer.name,
            'net': _amount(inv.net()),
            'vat': _amount(inv.vat()),
            'total': _amount(inv.total()),
            'account': '1100',
        })
    return rows


def export_ledger(root, out):
    """Writes the ledger to ``out``, a file opened in binary mode."""
    rows = ledger_rows(root)
    writer = csv.writer(out, delimiter=';', lineterminator='\r\n')
    writer.writerow(rows[0].keys())
    for row in rows:
        writer.writerow([_cp1252(v) for v in row.values()])
