# -*- coding: utf-8 -*-
"""Text and number formatting.

Convention in this codebase (since 2007): every string inside the app is a
UTF-8 encoded byte string (``str``). Only the helpers below touch ``unicode``.
"""
import unicodedata

ELLIPSIS = '\xe2\x80\xa6'  # U+2026 as UTF-8 bytes


def to_unicode(s):
    if isinstance(s, unicode):
        return s
    return s.decode('utf-8')


def to_bytes(s):
    if isinstance(s, unicode):
        return s.encode('utf-8')
    return s


def fold(s):
    """Lowercase and strip accents: 'Zürich' -> 'zurich'."""
    u = unicodedata.normalize('NFKD', to_unicode(s))
    u = u''.join([c for c in u if not unicodedata.combining(c)])
    return u.lower().encode('utf-8')


def truncate(s, n):
    """Truncate to n *characters* (not bytes) and add an ellipsis."""
    u = to_unicode(s)
    if len(u) <= n:
        return to_bytes(u)
    return to_bytes(u[:n - 1]) + ELLIPSIS


def thousands(n):
    """Swiss grouping: 1234567 -> 1'234'567."""
    s = str(int(n))
    groups = []
    while len(s) > 3:
        groups.insert(0, s[-3:])
        s = s[:-3]
    groups.insert(0, s)
    return "'".join(groups)


def chf(rappen):
    """123456 -> "CHF 1'234.56". Amounts are integers in Rappen."""
    sign = '-' if rappen < 0 else ''
    rappen = abs(rappen)
    return 'CHF %s%s.%02d' % (sign, thousands(rappen / 100), rappen % 100)


def parse_chf(text):
    """'1234.50' or '1234,50' -> 123450."""
    return int(round(float(text.replace(',', '.')) * 100))
