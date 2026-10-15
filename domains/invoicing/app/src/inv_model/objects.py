# -*- coding: utf-8 -*-
"""Persistent domain objects. Class paths are stored in the data file:
moving or renaming these classes breaks existing ledgers."""
from inv_store import Persistent
from inv_money import vat_of, skonto


class Customer(Persistent):

    def __init__(self, id, name, city, email, skonto_pct=0, tags=None):
        self.id = id
        self.name = name
        self.city = city
        self.email = email
        self.skonto_pct = skonto_pct    # early-payment discount in percent
        self.tags = tags or {}          # tag -> True

    def display(self):
        return '%s, %s' % (self.name, self.city)


class Line(Persistent):

    def __init__(self, text, qty, unit, vat_bp):
        self.text = text
        self.qty = qty                  # pieces or hours, may be fractional
        self.unit = unit                # Rappen
        self.vat_bp = vat_bp

    def net(self):
        return int(round(self.qty * self.unit))

    def vat(self):
        return vat_of(self.net(), self.vat_bp)


class Invoice(Persistent):

    def __init__(self, id, customer, issued, due, lines, note=''):
        self.id = id
        self.customer = customer
        self.issued = issued            # datetime.date
        self.due = due                  # datetime.date, or None = payable on receipt
        self.lines = lines
        self.payments = []              # [(datetime.date, Rappen)]
        self.note = note

    def net(self):
        return sum([l.net() for l in self.lines])

    def vat(self):
        return sum([l.vat() for l in self.lines])

    def total(self):
        return self.net() + self.vat()

    def paid(self):
        return sum([amount for _, amount in self.payments])

    def outstanding(self):
        return self.total() - self.paid()

    def skonto_amount(self):
        return skonto(self.total(), self.customer.skonto_pct)

    def days_overdue(self, as_of):
        if self.due is None:
            return (as_of - self.issued).days
        return (as_of - self.due).days

    def status(self, as_of):
        if self.outstanding() <= 0:
            return 'paid'
        if self.days_overdue(as_of) > 0:
            return 'overdue'
        return 'open'
