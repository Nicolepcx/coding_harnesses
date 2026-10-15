# -*- coding: utf-8 -*-
"""WSGI front end: invoice list and search, invoice and customer pages,
aging report and the ledger download."""
import cgi
import urlparse
import cStringIO

from inv_store import open_root
from inv_text import truncate, chf, to_bytes
from inv_paging import page_links
from inv_search import search_invoices
from inv_report import aging, BUCKETS, CLOSE_DATE
from inv_export import export_ledger

PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>%(title)s</title></head>
<body>
<header><a href="/">Invoices</a> <a href="/aging">Aging</a></header>
<main>
%(body)s
</main>
</body></html>
"""


def _page(title, body):
    return PAGE % {'title': cgi.escape(title), 'body': body}


def _list_view(root, params):
    query = params.get('q', [''])[0]
    try:
        page = int(params.get('page', ['1'])[0])
    except ValueError:
        page = 1
    hits, total, page, pages = search_invoices(root, query, page)
    out = ['<form action="/" method="get">'
           '<input name="q" value="%s" aria-label="Search">'
           '<button type="submit">Search</button></form>' % cgi.escape(query, True),
           '<p class="summary">%d invoices, page %d of %d</p>' % (total, page, pages),
           '<table class="invoices">']
    for inv in hits:
        out.append('<tr><td><a href="/invoice/%s">%s</a></td><td>%s</td><td class="amount">%s</td>'
                   '<td class="status">%s</td></tr>'
                   % (inv.id, inv.id, cgi.escape(truncate(inv.customer.name, 24)),
                      chf(inv.total()), inv.status(CLOSE_DATE)))
    out.append('</table>')
    links = []
    for n, current in page_links(total, page):
        if current:
            links.append('<strong>%d</strong>' % n)
        else:
            links.append('<a href="/?q=%s&amp;page=%d">%d</a>' % (cgi.escape(query, True), n, n))
    out.append('<nav class="pages">%s</nav>' % ' '.join(links))
    return _page('Invoices', '\n'.join(out))


def _invoice_view(root, inv_id):
    inv = root['invoices'].get(inv_id)
    if inv is None:
        return None
    c = inv.customer
    out = ['<h1>%s</h1>' % inv.id,
           '<p class="customer"><a href="/customer/%s">%s</a></p>' % (c.id, cgi.escape(c.display())),
           '<p class="dates">Issued %s, due %s</p>'
           % (inv.issued.strftime('%d.%m.%Y'), inv.due.strftime('%d.%m.%Y') if inv.due else 'on receipt'),
           '<table class="lines">']
    for l in inv.lines:
        out.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>'
                   % (cgi.escape(l.text), l.qty, chf(l.unit), chf(l.net())))
    out.append('</table>')
    out.append('<p class="totals">Net %s, VAT %s, total <b>%s</b></p>'
               % (chf(inv.net()), chf(inv.vat()), chf(inv.total())))
    if c.skonto_pct:
        out.append('<p class="skonto">%d%% early-payment discount: %s</p>'
                   % (c.skonto_pct, chf(inv.skonto_amount())))
    out.append('<p class="outstanding">Outstanding: %s</p>' % chf(inv.outstanding()))
    return _page(inv.id, '\n'.join(out))


def _customer_view(root, cust_id):
    c = root['customers'].get(cust_id)
    if c is None:
        return None
    tags = sorted([to_bytes(t) for t in c.tags])
    invoices = sorted([i for i in root['invoices'].values() if i.customer is c], key=lambda i: i.id)
    out = ['<h1>%s</h1>' % cgi.escape(c.name),
           '<p class="city">%s</p>' % cgi.escape(c.city),
           '<p class="tags">%s</p>' % cgi.escape(', '.join(tags)),
           '<ul class="invoices">']
    for inv in invoices:
        out.append('<li><a href="/invoice/%s">%s</a> %s</li>' % (inv.id, inv.id, chf(inv.outstanding())))
    out.append('</ul>')
    return _page(c.name, '\n'.join(out))


def _aging_view(root):
    result = aging(root)
    out = ['<h1>Aging at %s</h1>' % CLOSE_DATE.strftime('%d.%m.%Y'), '<table class="aging">']
    for b in BUCKETS:
        count, amount = result[b]
        out.append('<tr><td>%s</td><td>%d</td><td>%s</td></tr>' % (b, count, chf(amount)))
    out.append('</table>')
    return _page('Aging', '\n'.join(out))


def make_app(data_path):

    def application(environ, start_response):
        root = open_root(data_path)
        path = environ.get('PATH_INFO', '/')
        params = urlparse.parse_qs(environ.get('QUERY_STRING', ''), keep_blank_values=True)
        ctype = 'text/html; charset=utf-8'
        if path == '/':
            body = _list_view(root, params)
        elif path.startswith('/invoice/'):
            body = _invoice_view(root, path[len('/invoice/'):])
        elif path.startswith('/customer/'):
            body = _customer_view(root, path[len('/customer/'):])
        elif path == '/aging':
            body = _aging_view(root)
        elif path == '/ledger.csv':
            buf = cStringIO.StringIO()
            export_ledger(root, buf)
            body = buf.getvalue()
            ctype = 'text/csv; charset=windows-1252'
        else:
            body = None
        if body is None:
            start_response('404 Not Found', [('Content-Type', 'text/plain')])
            return ['not found']
        start_response('200 OK', [('Content-Type', ctype), ('Content-Length', str(len(body)))])
        return [body]

    return application
