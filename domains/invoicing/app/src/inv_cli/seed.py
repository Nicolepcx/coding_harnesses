# -*- coding: utf-8 -*-
"""Deterministic demo ledger. Only ever run under Python 2: the resulting
data file is the 'production database' the migration must keep readable."""
import datetime

from inv_model import Customer, Invoice, Line
from inv_money import VAT_RATES

D = datetime.date
STD, RED, LOD = VAT_RATES['standard'], VAT_RATES['reduced'], VAT_RATES['lodging']

CUSTOMERS = [
    # id, name, city, email, skonto %
    ('C01', 'Müller Holzbau AG', 'Zürich', 'buchhaltung@mueller-holzbau.example', 0),
    ('C02', 'Bäckerei Groß GmbH', 'Bern', 'office@baeckerei-gross.example', 2),
    ('C03', 'Société Générale de Conseil SA', 'Genève', 'factures@sgc.example', 2),
    ('C04', 'Spital Thun', 'Thun', 'kreditoren@spital-thun.example', 0),
    ('C05', 'Zoë Brunner Physiotherapie', 'Spiez', 'praxis@brunner-physio.example', 3),
    ('C06', 'Ölz & Partner', 'Winterthur', 'admin@oelz-partner.example', 2),
]

# Tags were entered through the web form (unicode) or imported from the old
# CRM via CSV (UTF-8 byte strings). Some customers ended up with both.
TAGS = {
    'C01': [u'Stammkunde'],
    'C02': ['Großkunde', u'Gro\xdfkunde', 'Bäckerei'],
    'C03': [u'Romandie', u'Fran\xe7ais'],
    'C04': ['Öffentliche Hand'],
    'C05': [],
    'C06': [u'Stammkunde', 'Région Zürich'],
}

INVOICES = [
    # id, customer, issued, due (None = on receipt), lines [(text, qty, unit Rappen, vat)], payments [(date, Rappen)]
    ('INV-2025-101', 'C01', D(2025, 9, 3), D(2025, 10, 3),
     [('Balkenlage Lärche, Montage', 12, 9500, STD), ('Kranmiete halber Tag', 1, 48000, STD)],
     [(D(2025, 9, 30), 175122)]),
    ('INV-2025-102', 'C02', D(2025, 9, 15), D(2025, 10, 15),
     [('Brot und Gebäck, Lieferung September', 1, 212500, RED)],
     [(D(2025, 10, 9), 213664)]),
    ('INV-2025-103', 'C03', D(2025, 10, 1), D(2025, 10, 31),
     [('Conseil stratégique, journées', 3, 145000, STD), ('Frais de déplacement', 1, 18750, STD)],
     [(D(2025, 11, 20), 490503)]),
    ('INV-2025-104', 'C04', D(2025, 10, 7), None,
     [('Physiotherapie Fortbildung', 2.5, 18000, STD), ('Unterkunft Referentin', 2, 14500, LOD)],
     []),
    ('INV-2025-105', 'C05', D(2025, 10, 20), D(2025, 11, 19),
     [('Praxiseinrichtung, Liege', 1, 248000, STD)],
     [(D(2025, 11, 5), 268088)]),
    ('INV-2025-106', 'C06', D(2025, 11, 2), D(2025, 12, 2),
     [('Beratung Steuern 2025', 7.5, 21000, STD), ('Spesen', 1, 4625, STD)],
     [(D(2025, 12, 1), 171751)]),
    ('INV-2025-107', 'C01', D(2025, 11, 18), D(2025, 12, 18),
     [('Fenster Eiche, Einbau', 6, 87500, STD)],
     [(D(2025, 12, 30), 300000)]),
    ('INV-2025-108', 'C02', D(2025, 12, 1), D(2025, 12, 31),
     [('Weihnachtsgebäck', 340, 450, RED), ('Lieferpauschale', 1, 3500, STD)],
     []),
    ('INV-2025-109', 'C03', D(2025, 12, 12), D(2026, 1, 11),
     [('Atelier « Café & Clients »', 1, 225000, STD)],
     [(D(2026, 1, 8), 238360)]),
    ('INV-2026-001', 'C04', D(2026, 1, 9), D(2026, 2, 8),
     [('Schulung Hygiene', 4, 32500, STD), ('Kursunterlagen', 25, 1290, RED)],
     [(D(2026, 2, 20), 173618)]),
    ('INV-2026-002', 'C05', D(2026, 1, 22), None,
     [('Massageöl, Karton', 12, 3450, RED)],
     [(D(2026, 1, 22), 42476)]),
    ('INV-2026-003', 'C06', D(2026, 2, 3), D(2026, 3, 5),
     [('Jahresabschluss 2025', 1, 680000, STD)],
     []),
    ('INV-2026-004', 'C01', D(2026, 2, 17), D(2026, 3, 19),
     [('Dachsanierung, Etappe 1', 1, 1450000, STD), ('Gerüst', 18, 2750, STD)],
     [(D(2026, 3, 18), 800000)]),
    ('INV-2026-005', 'C02', D(2026, 3, 2), D(2026, 4, 1),
     [('Brot und Gebäck, Lieferung Februar', 1, 198500, RED)],
     [(D(2026, 3, 30), 203661)]),
    ('INV-2026-006', 'C03', D(2026, 3, 16), D(2026, 4, 15),
     [('Analyse de marché', 5, 132000, STD)],
     []),
    ('INV-2026-007', 'C04', D(2026, 3, 30), D(2026, 4, 29),
     [('Notfallübung, Begleitung', 9.25, 16000, STD)],
     []),
    ('INV-2026-008', 'C05', D(2026, 4, 8), D(2026, 5, 8),
     [('Therapieband-Set', 40, 1975, RED), ('Versand', 1, 1450, STD)],
     [(D(2026, 5, 2), 80142)]),
    ('INV-2026-009', 'C06', D(2026, 4, 21), None,
     [('Lohnbuchhaltung April', 1, 95000, STD)],
     []),
    ('INV-2026-010', 'C01', D(2026, 5, 4), D(2026, 6, 3),
     [('Treppe Esche, Fertigung', 1, 1125000, STD)],
     []),
    ('INV-2026-011', 'C02', D(2026, 5, 18), D(2026, 6, 17),
     [('Brot und Gebäck, Lieferung April', 1, 205000, RED), ('Zuschlag Sonntag', 4, 2500, RED)],
     []),
    ('INV-2026-012', 'C03', D(2026, 6, 1), D(2026, 7, 1),
     [('Formation « Négociation »', 2, 160000, STD)],
     []),
    ('INV-2026-013', 'C04', D(2026, 6, 10), D(2026, 7, 10),
     [('Gästezimmer Seminar', 6, 13250, LOD), ('Verpflegung', 30, 3150, RED)],
     []),
    ('INV-2026-014', 'C05', D(2026, 6, 19), D(2026, 7, 19),
     [('Praxisumbau Planung', 13.5, 14414, STD)],
     []),
    ('INV-2026-015', 'C06', D(2026, 6, 26), D(2026, 7, 26),
     [('Revision Kasse', 1, 72400, STD), ('<Sonderprüfung> & Bericht', 1, 31000, STD)],
     []),
]


def build_root():
    customers = {}
    for cid, name, city, email, skonto_pct in CUSTOMERS:
        tags = {}
        for t in TAGS[cid]:
            tags[t] = True
        customers[cid] = Customer(cid, name, city, email, skonto_pct, tags)
    invoices = {}
    for iid, cid, issued, due, lines, payments in INVOICES:
        inv = Invoice(iid, customers[cid], issued, due,
                      [Line(text, qty, unit, vat) for text, qty, unit, vat in lines])
        inv.payments = list(payments)
        invoices[iid] = inv
    return {'customers': customers, 'invoices': invoices, 'schema': 4}
