"""Receivables reports for the monthly close."""
import datetime

# The books close on this date; reports default to it.
CLOSE_DATE = datetime.date(2026, 6, 30)

BUCKETS = ['current', '1-30', '31-60', '61-90', '90+']


def bucket_of(days):
    if days <= 0:
        return 'current'
    if days <= 30:
        return '1-30'
    if days <= 60:
        return '31-60'
    if days <= 90:
        return '61-90'
    return '90+'


def aging(root, as_of=CLOSE_DATE):
    """Outstanding amounts per bucket: {bucket: (count, Rappen)}."""
    result = {}
    for b in BUCKETS:
        result[b] = (0, 0)
    for inv in root['invoices'].values():
        if inv.outstanding() <= 0 or inv.issued > as_of:
            continue
        b = bucket_of(inv.days_overdue(as_of))
        count, amount = result[b]
        result[b] = (count + 1, amount + inv.outstanding())
    return result


def open_invoices(root, as_of=CLOSE_DATE):
    """Open invoices by due date; 'on receipt' invoices first."""
    items = [i for i in root['invoices'].values()
             if i.outstanding() > 0 and i.issued <= as_of]
    return sorted(items, key=lambda i: (i.due and i.due.isoformat(), i.id))


def stats(root):
    invoices = root['invoices'].values()
    totals = [i.total() for i in invoices]
    paid = [i for i in invoices if i.payments and i.outstanding() <= 0]
    days = [(i.payments[-1][0] - i.issued).days for i in paid]
    return {
        'count': len(totals),
        'billed': sum(totals),
        'average': sum(totals) / len(totals),
        'paid_count': len(paid),
        'avg_days_to_pay': sum(days) / float(len(days)) if days else 0.0,
    }
