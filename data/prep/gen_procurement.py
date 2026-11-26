"""Generate a synthetic public-procurement dataset as an OCDS release package.

The output uses the Open Contracting Data Standard (OCDS 1.1 + bids extension),
so it goes through exactly the same adapter as real OCDS publications
(for example the Slovenian OCDS feed or other publishers from the OCDS registry).

All buyers and suppliers are fictional.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

from common import CATEGORIES, RAW, YEARS, FirmRegistry, random_date, write_json
from ocds_adapter import ocds_payment_id

# (category, procurements per year (min, max), contract kind, mode, params)
#   mode "unit":  params = (qty_min, qty_max, unit_price_min, unit_price_max)
#   mode "value": params = (value_min, value_max)
PROCUREMENT_SPECS = [
    ("laptop", (1, 2), "goods", "unit", (6, 40, 95000, 115000)),
    ("desktop_pc", (1, 2), "goods", "unit", (12, 30, 62000, 85000)),
    ("toner", (1, 1), "goods", "unit", (200, 400, 3800, 5600)),
    ("office_paper", (1, 2), "goods", "unit", (2000, 6000, 420, 560)),
    ("fuel", (1, 1), "goods", "unit", (20000, 90000, 175, 195)),
    ("road_repair", (2, 4), "works", "unit", (1100, 3000, 2200, 3200)),
    ("street_lighting", (0, 2), "works", "value", (3500000, 9000000)),
    ("cleaning_services", (1, 1), "services", "value", (3000000, 9000000)),
    ("consulting", (0, 2), "services", "value", (1200000, 4000000)),
    ("it_services", (0, 2), "services", "value", (1100000, 3000000)),
]
DIRECT_SPECS = [  # purchases below the exemption threshold
    ("toner", "goods", "unit", (10, 60, 3800, 5600)),
    ("office_paper", "goods", "unit", (100, 900, 420, 560)),
    ("laptop", "goods", "unit", (1, 7, 95000, 115000)),
    ("maintenance", "services", "value", (100000, 995000)),
    ("consulting", "services", "value", (150000, 900000)),
    ("events", "services", "value", (100000, 800000)),
    ("equipment", "goods", "value", (100000, 900000)),
]
STREETS = ["Jorgovana", "Ruža", "Lala", "Breza", "Topola", "Kestena", "Bagrema", "Javora", "Lipa",
           "Jasena", "Hrasta", "Vrba", "Dunja", "Višanja", "Šljiva", "Oraha", "Nikole Tesle", "Cara Dušana",
           "Vuka Karadžića", "Svetog Save"]
BID_COUNT_WEIGHTS = {1: 0.12, 2: 0.25, 3: 0.3, 4: 0.2, 5: 0.13}
UNIT_LABELS = {"laptop": "kom", "desktop_pc": "kom", "toner": "kom", "office_paper": "risma", "fuel": "litar",
               "road_repair": "m2"}
TITLES = {
    "laptop": "Nabavka laptop računara", "desktop_pc": "Nabavka desktop računara", "toner": "Nabavka tonera",
    "office_paper": "Nabavka kancelarijskog papira", "fuel": "Nabavka goriva",
    "road_repair": "Sanacija kolovoza", "street_lighting": "Rekonstrukcija javne rasvete",
    "cleaning_services": "Usluge čišćenja zgrade opštine", "consulting": "Konsultantske usluge",
    "it_services": "Održavanje informacionog sistema", "maintenance": "Tekuće održavanje objekata",
    "events": "Organizacija manifestacije", "equipment": "Nabavka opreme i nameštaja",
}
METHOD_DETAILS = {"open": "Otvoreni postupak", "limited": "Pregovarački postupak bez objavljivanja poziva",
                  "direct": "Nabavka na koju se zakon ne primenjuje (ispod praga)"}


class ProcurementGenerator:
    def __init__(self, rng: random.Random, registry: FirmRegistry, ledger_pool, towns: list[str]):
        self.rng = rng
        self.registry = registry
        self.ledger_pool = ledger_pool  # share suppliers with the institution ledgers
        self.buyers = [{"id": f"MU{i + 1:02d}", "name": f"Opština {t}", "kind": "municipality", "municipality": t}
                       for i, t in enumerate(towns)]
        self.releases: list[dict] = []
        self.counter = 0
        self.extra_pools: dict[str, list] = {}

    def pool(self, category: str):
        if category in ("street_lighting", "it_services"):
            if category not in self.extra_pools:
                self.extra_pools[category] = [self.registry.new_firm(category) for _ in range(7)]
            return self.extra_pools[category]
        return self.ledger_pool(category)

    # ----- one procurement -----------------------------------------------------------
    def build(self, buyer: dict, *, category: str, kind: str, method: str, year: int | None = None,
              start: date | None = None, tender_days: int | None = None, qty: float | None = None,
              unit_price: float | None = None, value: float | None = None, bidders: list | None = None,
              bid_amounts: list[float] | None = None, award_status: str = "active",
              amendments: list[float] | None = None, description: str | None = None,
              street: str | None = None, tag: str | None = None) -> dict:
        rng = self.rng
        self.counter += 1
        start = start or random_date(rng, date(year, 1, 10), date(year, 10, 31))
        if tender_days is None:
            tender_days = {"open": rng.randint(30, 50), "limited": rng.randint(10, 20), "direct": rng.randint(3, 10)}[method]
        end = start + timedelta(days=tender_days)
        ocid = f"ocds-fict01-{buyer['id']}-{start.year}-{self.counter:04d}"

        if qty is not None:
            estimate = qty * unit_price * rng.uniform(1.0, 1.12)
        else:
            estimate = value * rng.uniform(1.0, 1.12)

        if bidders is None:
            n = 1 if method != "open" else rng.choices(list(BID_COUNT_WEIGHTS), weights=list(BID_COUNT_WEIGHTS.values()))[0]
            bidders = rng.sample(self.pool(category), n)
        if bid_amounts is None:
            base = qty * unit_price if qty is not None else value
            bid_amounts = [round(base * rng.uniform(0.92, 1.25)) for _ in bidders]
            # Winner is the lowest bid; make it equal to the target price.
            low = bid_amounts.index(min(bid_amounts))
            bid_amounts[low] = round(base)
        winner_idx = bid_amounts.index(min(bid_amounts))
        winner = bidders[winner_idx]
        award_value = bid_amounts[winner_idx]
        award_date = end + timedelta(days=rng.randint(10, 30))
        signed = award_date + timedelta(days=rng.randint(5, 15))

        item = {
            "id": "1",
            "description": description or TITLES[category],
            "classification": {"scheme": "CPV", "id": (CATEGORIES[category]["cpv"] or ["00000000"])[0]},
        }
        if qty is not None:
            item["quantity"] = qty
            item["unit"] = {"name": UNIT_LABELS.get(category, "kom"),
                            "value": {"amount": round(award_value / qty, 2), "currency": "RSD"}}
        if street:
            item["deliveryAddress"] = {"streetAddress": street, "locality": buyer["municipality"]}

        parties = [{"id": buyer["id"], "name": buyer["name"], "roles": ["buyer", "procuringEntity"]}]
        for b in bidders:
            roles = ["tenderer"] + (["supplier"] if b is winner else [])
            parties.append({"id": f"RS-PIB-{b.id}", "name": b.name, "roles": roles,
                            "identifier": {"scheme": "RS-PIB", "id": b.id, "legalName": b.name}})

        release = {
            "ocid": ocid,
            "id": f"{ocid}-compiled",
            "date": (signed if award_status == "active" else award_date).isoformat() + "T00:00:00Z",
            "tag": ["compiled"],
            "initiationType": "tender",
            "language": "sr",
            "parties": parties,
            "buyer": {"id": buyer["id"], "name": buyer["name"]},
            "tender": {
                "id": f"{ocid}-tender",
                "title": TITLES[category] + (f", {street}" if street else ""),
                "status": "complete" if award_status == "active" else "cancelled",
                "procurementMethod": method,
                "procurementMethodDetails": METHOD_DETAILS[method],
                "mainProcurementCategory": kind,
                "value": {"amount": round(estimate), "currency": "RSD"},
                "tenderPeriod": {"startDate": start.isoformat() + "T00:00:00Z", "endDate": end.isoformat() + "T00:00:00Z"},
                "numberOfTenderers": len(bidders),
                "items": [item],
            },
            "bids": {"details": [
                {"id": f"bid-{i + 1}", "status": "valid",
                 "tenderers": [{"id": f"RS-PIB-{b.id}", "name": b.name}],
                 "value": {"amount": amt, "currency": "RSD"}}
                for i, (b, amt) in enumerate(zip(bidders, bid_amounts))
            ]},
            "awards": [{"id": "award-1", "status": award_status, "date": award_date.isoformat() + "T00:00:00Z",
                        "value": {"amount": award_value, "currency": "RSD"},
                        "suppliers": [{"id": f"RS-PIB-{winner.id}", "name": winner.name}]}],
        }
        if award_status == "active":
            final_value = award_value
            amendment_items = []
            for i, factor in enumerate(amendments or []):
                final_value = round(award_value * factor)
                amendment_items.append({
                    "id": f"amendment-{i + 1}",
                    "date": (signed + timedelta(days=60 * (i + 1))).isoformat() + "T00:00:00Z",
                    "rationale": "Aneks ugovora - dodatni radovi" if kind == "works" else "Aneks ugovora",
                    "description": f"Vrednost ugovora izmenjena na {final_value} RSD",
                })
            contract = {"id": "contract-1", "awardID": "award-1", "status": "active",
                        "dateSigned": signed.isoformat() + "T00:00:00Z",
                        "value": {"amount": final_value, "currency": "RSD"}}
            if amendment_items:
                contract["amendments"] = amendment_items
            release["contracts"] = [contract]
        release["_tag"] = tag  # removed before writing; used to build the ground truth
        self.releases.append(release)
        return release

    def normal(self, buyer: dict, year: int, category: str, kind: str, mode: str, params, method: str | None = None,
               **overrides) -> dict:
        rng = self.rng
        threshold = 3_000_000 if kind == "works" else 1_000_000
        street = None
        if mode == "unit":
            qmin, qmax, pmin, pmax = params
            qty = rng.randint(qmin, qmax)
            unit_price = rng.uniform(pmin, pmax)
            value = qty * unit_price
        else:
            qty, unit_price = None, None
            value = rng.uniform(*params)
        if category == "road_repair":
            street = f"Ulica {rng.choice(STREETS)}"
        if method is None:
            if value < threshold:
                method = "direct"
            else:
                method = "limited" if rng.random() < 0.10 else "open"
        if mode == "unit" and category in UNIT_LABELS:
            desc = f"{TITLES[category]}, {qty} {UNIT_LABELS[category]}" + (f", {street}" if street else "")
        else:
            desc = TITLES[category]
        args = dict(category=category, kind=kind, method=method, year=year, qty=qty, unit_price=unit_price,
                    value=value, description=desc, street=street)
        if rng.random() < 0.06 and method != "direct":
            args["amendments"] = [rng.uniform(1.03, 1.15)]
        if rng.random() < 0.03:
            args["award_status"] = "cancelled"
        args.update(overrides)
        return self.build(buyer, **args)

    def generate_background(self, skip: set[tuple[str, str]]) -> None:
        """Normal procurement activity. `skip` holds (buyer id, category) pairs that are built by hand."""
        rng = self.rng
        for buyer in self.buyers:
            for year in YEARS:
                for category, count, kind, mode, params in PROCUREMENT_SPECS:
                    if (buyer["id"], category) in skip:
                        continue
                    for _ in range(rng.randint(*count)):
                        self.normal(buyer, year, category, kind, mode, params)
                for _ in range(rng.randint(6, 10)):
                    category, kind, mode, params = rng.choice(DIRECT_SPECS)
                    if (buyer["id"], category) in skip:
                        continue
                    rel = self.normal(buyer, year, category, kind, mode, params, method="direct")
                    # Exempt purchases must stay below the threshold.
                    assert rel["awards"][0]["value"]["amount"] < 1_000_000 or kind == "works"

    # ----- injected test cases -------------------------------------------------------
    def inject(self, alfa) -> list[dict]:
        rng = self.rng
        truth: list[dict] = []
        by_id = {b["id"]: b for b in self.buyers}
        it_pool = [f for f in self.pool("laptop") if f is not alfa]

        # Municipality X: laptops at 1,800 EUR, single bid, 3-day tender; split purchases; captive supplier.
        x = by_id["MU03"]
        self.build(x, category="laptop", kind="goods", method="open", start=date(2025, 6, 2), tender_days=3,
                   qty=40, unit_price=210000, bidders=[alfa], bid_amounts=[40 * 210000],
                   description="Laptop računari za upravu opštine, 40 kom", tag="T13")
        truth.append(dict(id="T13", title="40 laptops at 210,000 RSD each, one bid, 3-day tender",
                          primarySignal="PEER_PRICE", expectedSignals=["PEER_PRICE", "SINGLE_BID", "SHORT_TENDER"],
                          payerId=x["id"], recipientId=alfa.id))
        other = it_pool[0]
        for d, amount, firm in ((date(2025, 4, 7), 985400, alfa), (date(2025, 4, 29), 988900, alfa),
                                (date(2025, 5, 20), 981200, other), (date(2025, 6, 16), 989500, alfa)):
            qty = 9
            self.build(x, category="laptop", kind="goods", method="direct", start=d, qty=qty,
                       unit_price=amount / qty, bidders=[firm], bid_amounts=[amount],
                       description=f"Laptop računari, {qty} kom", tag="T14")
        truth.append(dict(id="T14", title="Four IT purchases in one quarter, each 1-2% below the 1,000,000 RSD threshold",
                          primarySignal="SPLIT", expectedSignals=["SPLIT"], payerId=x["id"], recipientId=alfa.id))
        # Six more IT procurements; Alfa wins five (one of those awards is later cancelled).
        plan = [("desktop_pc", 2024, alfa, "active"), ("toner", 2024, alfa, "active"),
                ("laptop", 2024, alfa, "cancelled"), ("desktop_pc", 2025, alfa, "active"),
                ("toner", 2025, it_pool[1], "active"), ("laptop", 2024, alfa, "active")]
        for category, year, winner, status in plan:
            spec = next(s for s in PROCUREMENT_SPECS if s[0] == category)
            qmin, qmax, pmin, pmax = spec[4]
            qty = rng.randint(qmin, qmax)
            price = rng.uniform(pmin, pmax)
            losers = rng.sample([f for f in it_pool if f is not winner], 2)
            bids = [round(qty * price)] + [round(qty * price * rng.uniform(1.05, 1.2)) for _ in losers]
            self.build(x, category=category, kind="goods", method="open", year=year, qty=qty, unit_price=price,
                       bidders=[winner] + losers, bid_amounts=bids, award_status=status,
                       description=f"{TITLES[category]}, {qty} {UNIT_LABELS[category]}", tag="T15")
        truth.append(dict(id="T15", title="One supplier wins 8 of 10 completed IT procurements of the municipality",
                          primarySignal="CONCENTRATION", expectedSignals=["CONCENTRATION"], payerId=x["id"],
                          recipientId=alfa.id))

        # Municipality Z: the same street repaired three times in two years by the same firm.
        z = by_id["MU07"]
        roads = self.registry.new_firm("road_repair", name="Put Gradnja Kolovoz d.o.o.")
        for d in (date(2024, 4, 8), date(2024, 10, 14), date(2025, 6, 9)):
            self.build(z, category="road_repair", kind="works", method="direct", start=d, qty=300,
                       unit_price=2000000 / 300, bidders=[roads], bid_amounts=[2000000],
                       description="Sanacija kolovoza, Ulica Lipa, 300 m2", street="Ulica Lipa", tag="T16")
        truth.append(dict(id="T16", title="Ulica Lipa repaired three times in two years, 6 million RSD, same firm",
                          primarySignal="REPEATED_OBJECT", expectedSignals=["REPEATED_OBJECT", "PEER_PRICE"],
                          payerId=z["id"], recipientId=roads.id))

        # Identical bid prices.
        b = by_id["MU05"]
        firms = rng.sample(self.pool("cleaning_services"), 3)
        self.build(b, category="cleaning_services", kind="services", method="open", start=date(2025, 2, 3),
                   value=5200000, bidders=firms, bid_amounts=[5200000, 5480000, 5480000],
                   description="Usluge čišćenja zgrade opštine", tag="T17")
        truth.append(dict(id="T17", title="Two bids with exactly the same price",
                          primarySignal="IDENTICAL_BIDS", expectedSignals=["IDENTICAL_BIDS"], payerId=b["id"],
                          recipientId=firms[0].id))

        # Second-lowest bid suspiciously close to the winner.
        b = by_id["MU09"]
        firms = rng.sample(self.pool("fuel"), 3)
        self.build(b, category="fuel", kind="goods", method="open", start=date(2024, 9, 2), qty=33000,
                   unit_price=6120000 / 33000, bidders=firms, bid_amounts=[6120000, 6122000, 6690000],
                   description="Nabavka goriva, 33000 litar", tag="T18")
        truth.append(dict(id="T18", title="Second bid only 0.03% above the winning bid",
                          primarySignal="CLOSE_SECOND_BID", expectedSignals=["CLOSE_SECOND_BID"], payerId=b["id"],
                          recipientId=firms[0].id))

        # Contract value inflated by amendments: 10M -> 16M.
        b = by_id["MU11"]
        firms = rng.sample(self.pool("street_lighting"), 3)
        self.build(b, category="street_lighting", kind="works", method="open", start=date(2024, 3, 4), value=10000000,
                   bidders=firms, bid_amounts=[10000000, 10900000, 11400000], amendments=[1.3, 1.6],
                   description="Rekonstrukcija javne rasvete u centru", tag="T19")
        truth.append(dict(id="T19", title="Contract won at 10 million RSD, worth 16 million after amendments",
                          primarySignal="AMENDMENT_INFLATION", expectedSignals=["AMENDMENT_INFLATION"],
                          payerId=b["id"], recipientId=firms[0].id))

        # Very wide bid spread.
        b = by_id["MU02"]
        firms = rng.sample(self.pool("consulting"), 3)
        self.build(b, category="consulting", kind="services", method="open", start=date(2025, 8, 4), value=2100000,
                   bidders=firms, bid_amounts=[2100000, 4800000, 5000000],
                   description="Izrada plana razvoja opštine", tag="T20")
        truth.append(dict(id="T20", title="Bids range from 2.1 to 5.0 million RSD for the same service",
                          primarySignal="WIDE_BID_SPREAD", expectedSignals=["WIDE_BID_SPREAD"], payerId=b["id"],
                          recipientId=firms[0].id))

        # Clean controls.
        b = by_id["MU04"]
        firms = rng.sample(it_pool, 3)
        self.build(b, category="laptop", kind="goods", method="open", start=date(2025, 3, 10), qty=4,
                   unit_price=182000, bidders=firms, bid_amounts=[4 * 182000, 4 * 191000, 4 * 199500],
                   description="Mobilna radna stanica za GIS odeljenje (Dell Precision 7680, RTX 3500 Ada, 64 GB RAM), 4 kom",
                   tag="C03")
        truth.append(dict(id="C03", clean=True, title="High-end GIS workstations (expensive for a stated reason)",
                          payerId=b["id"], recipientId=firms[0].id))
        b = by_id["MU08"]
        firm = rng.choice(self.pool("road_repair"))
        self.build(b, category="road_repair", kind="works", method="limited", start=date(2024, 5, 20), tender_days=5,
                   qty=1400, unit_price=2850, bidders=[firm], bid_amounts=[1400 * 2850],
                   description="Hitna sanacija kolovoza posle poplave, Ulica Topola, 1400 m2", street="Ulica Topola",
                   tag="C04")
        truth.append(dict(id="C04", clean=True, title="Emergency negotiated repair after a flood (single bid is expected)",
                          payerId=b["id"], recipientId=firm.id))
        return truth

    def inject_noncompetitive(self) -> dict:
        """Run after the background: convert many procedures of one buyer to negotiated ones."""
        b = next(x for x in self.buyers if x["id"] == "MU06")
        mine = [r for r in self.releases if r["buyer"]["id"] == b["id"] and r["tender"]["procurementMethod"] == "open"
                and r["_tag"] is None]
        for rel in mine[: max(1, int(len(mine) * 0.5))]:
            rel["tender"]["procurementMethod"] = "limited"
            rel["tender"]["procurementMethodDetails"] = METHOD_DETAILS["limited"]
            rel["_tag"] = "T21"
        return dict(id="T21", title="Half of the municipality's procurements use negotiated procedures without a call",
                    primarySignal="NONCOMPETITIVE_SHARE", expectedSignals=["NONCOMPETITIVE_SHARE"], payerId=b["id"],
                    recipientId=None)

    def write(self) -> dict[str, list[str]]:
        tags: dict[str, list[str]] = {}
        clean_releases = []
        for rel in self.releases:
            tag = rel.pop("_tag")
            tags.setdefault(tag or "_untagged", []).append(ocds_payment_id(rel))
            clean_releases.append(rel)
        package = {
            "uri": "https://example.invalid/inquest/synthetic-ocds.json",
            "version": "1.1",
            "publishedDate": "2026-01-15T00:00:00Z",
            "publisher": {"name": "Inquest synthetic data generator (fictional)"},
            "extensions": ["https://raw.githubusercontent.com/open-contracting-extensions/ocds_bid_extension/master/extension.json"],
            "releases": clean_releases,
        }
        write_json(RAW / "procurement" / "synthetic_ocds.json", package)
        return tags
