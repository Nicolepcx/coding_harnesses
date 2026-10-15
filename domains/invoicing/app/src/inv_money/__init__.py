"""Money rules. All amounts are integers in Rappen (1/100 CHF).

VAT rates are basis points: 810 = 8.1 %. VAT per line is truncated to the
Rappen, as the accounting system has always done it.
"""

VAT_RATES = {
    'standard': 810,
    'reduced': 260,
    'lodging': 380,
}


def vat_of(net, rate_bp):
    return net * rate_bp / 10000


def skonto(amount, percent):
    """Early-payment discount, rounded to the Rappen the way the bank does it."""
    return int(round(amount * percent / 100.0))


def split_installments(amount, n):
    """Equal installments; the first one takes the remainder."""
    base = amount / n
    first = amount - base * (n - 1)
    return [first] + [base] * (n - 1)
