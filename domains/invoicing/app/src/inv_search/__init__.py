"""Invoice search: customer name, city, invoice number, line texts."""
from inv_text import fold
from inv_paging import page_slice, page_count, clamp, PER_PAGE


def _by_customer(a, b):
    return cmp(fold(a.customer.name), fold(b.customer.name)) or cmp(a.id, b.id)


def search_invoices(root, query, page=1, per_page=PER_PAGE):
    """Returns (hits_on_page, total, page, pages)."""
    q = fold(query)
    hits = []
    for inv in root['invoices'].values():
        hay = ' '.join([fold(inv.id), fold(inv.customer.name), fold(inv.customer.city)] +
                       [fold(l.text) for l in inv.lines])
        if q in hay:
            hits.append(inv)
    hits.sort(_by_customer)
    total = len(hits)
    page = clamp(page, total, per_page)
    return page_slice(hits, page, per_page), total, page, page_count(total, per_page)
