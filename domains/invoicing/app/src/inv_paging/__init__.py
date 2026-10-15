"""Pagination used by the invoice list, the web UI and the CLI."""

PER_PAGE = 10


def page_count(total, per_page=PER_PAGE):
    return total / per_page + (1 if total % per_page else 0)


def clamp(page, total, per_page=PER_PAGE):
    n = max(page_count(total, per_page), 1)
    return min(max(page, 1), n)


def page_slice(items, page, per_page=PER_PAGE):
    start = (page - 1) * per_page
    return items[start:start + per_page]


def page_links(total, current, per_page=PER_PAGE):
    return [(n, n == current) for n in range(1, page_count(total, per_page) + 1)]
