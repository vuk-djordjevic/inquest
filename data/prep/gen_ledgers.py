"""Generate synthetic but realistic payment ledgers for small public institutions.

Four kinds of institutions (schools, health centers, utility companies, local
communities), 10-16 of each kind, two years of payments. Institutions of the
same kind buy the same kinds of things at comparable prices, so they can be
compared with each other. On top of the normal background we inject test cases
with known risk signals and record them in the ground-truth file, which the
agents never see.

All names are fictional.
"""

from __future__ import annotations

import csv
import random
from collections import defaultdict
from datetime import date, timedelta

from common import RAW, YEARS, EUR_TO_RSD, FirmRegistry, random_date
from ledger_adapter import (
    CATEGORY_TO_EXPENSE_TYPE, LEDGER_COLUMNS, UNIT_TO_UNIT_LABEL, format_rsd, ledger_payment_id,
)

TOWNS = [
    "Zelengrad", "Javorovac", "Brestograd", "Rečinac", "Borovik Donji", "Sunčani Breg",
    "Vrbograd", "Gornji Brod", "Lipovo Polje", "Kamengrad", "Hrastovac Novi", "Jasenograd",
]
SCHOOL_NAMES = ["Lipa", "Javor", "Bagrem", "Hrast", "Breza", "Jasen", "Bor", "Kesten",
                "Platan", "Topola", "Vrba", "Smrča", "Jela", "Dren", "Glog", "Leska"]
COMMUNITY_NAMES = ["Centar", "Novo Naselje", "Lipar", "Breg", "Polje", "Ravnište", "Potok",
                   "Vinogradi", "Stari Grad", "Kej"]
MONTHS_SR = ["januar", "februar", "mart", "april", "maj", "jun", "jul", "avgust", "septembar",
             "oktobar", "novembar", "decembar"]

DESTINATIONS = [("Kopaonik", 2), ("Zlatibor", 2), ("Tara", 2), ("Novi Sad i Fruška gora", 1),
                ("Subotica i Palić", 2), ("Golubac i Đerdap", 2), ("Beograd", 1),
                ("manastiri istočne Srbije", 2), ("Vojvodina - salaši", 1)]
LAPTOP_MODELS = ["Lenovo ThinkPad E14", "HP ProBook 450", "Dell Latitude 3540", "Asus ExpertBook B1"]
TONER_MODELS = ["HP 85A", "HP 26A", "Canon 725", "Brother TN-2421", "Samsung MLT-D111S"]

TEXT_CHOICES = {
    "maintenance": ["Popravka grejanja", "Servis klima uređaja", "Zamena brava i okova", "Popravka krova",
                    "Servis vodovodnih instalacija", "Popravka rasvete", "Zamena stakla na prozorima"],
    "consulting": ["Izrada pravilnika o zaštiti podataka o ličnosti", "Konsultantske usluge za strateški plan",
                   "Savetovanje u postupku javnih nabavki", "Izrada elaborata energetske efikasnosti"],
    "it_services": ["Održavanje knjigovodstvenog softvera", "Održavanje računarske mreže",
                    "Hosting i održavanje sajta"],
    "events": ["Organizacija Dana mesne zajednice", "Novogodišnji koncert za decu", "Turnir u malom fudbalu",
               "Izložba lokalnih umetnika"],
    "equipment": ["Kancelarijske stolice", "Ormar za arhivu", "Klupe za park", "Projektor i platno",
                  "Kancelarijski stolovi", "Klima uređaj za salu", "Police za arhivu"],
    "teaching_materials": ["Udžbenici za biblioteku", "Geografske karte", "Laboratorijski pribor za hemiju",
                           "Sportski rekviziti", "Muzički instrumenti za kabinet"],
    "medical_consumables": ["Sterilne gaze i zavoji", "Šprici i igle", "Test trake za glukozu",
                            "Dezinfekciona sredstva", "Urinarni kateteri"],
    "other": ["Bankarska provizija", "Poštanske usluge", "Takse za registraciju vozila",
              "Članarina u strukovnom udruženju", "Overa dokumenata kod notara"],
}

# Category spec per institution kind:
#   (category, payments_per_year (min, max), mode, params)
# mode "unit":    params = (qty_min, qty_max, unit_price_min, unit_price_max)
# mode "amount":  params = (amount_min, amount_max)
# mode "monthly": params = (amount_min, amount_max), one payment per month
KIND_SPECS = {
    "school": [
        ("excursion", (2, 2), "unit", (40, 180, 8000, 11500)),
        ("painting", (1, 1), "unit", (150, 600, 380, 520)),
        ("maintenance", (8, 14), "amount", (8000, 75000)),
        ("toner", (3, 6), "unit", (2, 12, 3800, 5600)),
        ("laptop", (0, 2), "unit", (1, 6, 78000, 108000)),
        ("teaching_materials", (4, 8), "amount", (5000, 60000)),
        ("canteen_food", (10, 12), "amount", (40000, 160000)),
        ("office_paper", (2, 4), "unit", (10, 60, 420, 560)),
        ("electricity", None, "monthly", (25000, 90000)),
        ("water_utilities", None, "monthly", (8000, 30000)),
        ("other", (2, 5), "amount", (1000, 15000)),
    ],
    "health_center": [
        ("gloves", (6, 10), "unit", (20, 200, 650, 900)),
        ("medical_consumables", (10, 16), "amount", (20000, 300000)),
        ("toner", (4, 8), "unit", (4, 20, 3800, 5600)),
        ("laptop", (0, 3), "unit", (2, 8, 78000, 108000)),
        ("office_paper", (3, 6), "unit", (20, 120, 420, 560)),
        ("maintenance", (8, 12), "amount", (20000, 200000)),
        ("fuel", (12, 12), "unit", (200, 900, 175, 195)),
        ("cleaning_services", (12, 12), "amount", (80000, 160000)),
        ("electricity", None, "monthly", (90000, 260000)),
        ("water_utilities", None, "monthly", (20000, 60000)),
        ("other", (3, 6), "amount", (1000, 25000)),
    ],
    "utility": [
        ("fuel", (20, 24), "unit", (1000, 4000, 175, 195)),
        ("maintenance", (12, 20), "amount", (30000, 400000)),
        ("toner", (3, 6), "unit", (4, 16, 3800, 5600)),
        ("laptop", (0, 2), "unit", (1, 5, 78000, 108000)),
        ("desktop_pc", (0, 2), "unit", (2, 8, 62000, 85000)),
        ("road_repair", (2, 4), "unit", (80, 400, 2300, 3100)),
        ("consulting", (1, 3), "amount", (100000, 450000)),
        ("office_paper", (3, 5), "unit", (20, 80, 420, 560)),
        ("electricity", None, "monthly", (150000, 420000)),
        ("water_utilities", None, "monthly", (15000, 50000)),
        ("other", (3, 6), "amount", (1000, 30000)),
    ],
    "local_community": [
        ("events", (2, 5), "amount", (20000, 150000)),
        ("maintenance", (4, 8), "amount", (10000, 90000)),
        ("equipment", (6, 9), "amount", (20000, 120000)),
        ("painting", (0, 1), "unit", (80, 300, 380, 520)),
        ("office_paper", (1, 3), "unit", (5, 20, 420, 560)),
        ("electricity", None, "monthly", (8000, 30000)),
        ("water_utilities", None, "monthly", (3000, 12000)),
        ("other", (2, 4), "amount", (1000, 12000)),
    ],
}
KIND_COUNTS = {"school": 16, "health_center": 12, "utility": 10, "local_community": 10}
PLANNED_CATEGORIES = {"equipment", "maintenance", "teaching_materials", "events", "consulting"}
PREFERENCE_WEIGHTS = [0.4, 0.25, 0.2, 0.15]


def institution_name(kind: str, idx: int, town: str) -> str:
    if kind == "school":
        return f'OŠ "{SCHOOL_NAMES[idx % len(SCHOOL_NAMES)]}" {town}'
    if kind == "health_center":
        return f"Dom zdravlja {town}"
    if kind == "utility":
        return f'JKP "Komunalac" {town}'
    return f"MZ {COMMUNITY_NAMES[idx % len(COMMUNITY_NAMES)]} {town}"


class LedgerGenerator:
    def __init__(self, rng: random.Random, registry: FirmRegistry):
        self.rng = rng
        self.registry = registry
        self.institutions: list[dict] = []
        self.rows: dict[str, list[dict]] = defaultdict(list)  # institution id -> raw rows
        self.plans: list[dict] = []
        self.pools: dict[str, list] = {}
        self.preferences: dict[tuple[str, str], list] = {}

    # ----- vendors -----------------------------------------------------------------
    def pool(self, category: str):
        if category not in self.pools:
            size = 1 if category in ("electricity", "water_utilities") else 7
            self.pools[category] = [self.registry.new_firm(category) for _ in range(size)]
        return self.pools[category]

    def pick_vendor(self, inst_id: str, category: str):
        key = (inst_id, category)
        pool = self.pool(category)
        if len(pool) == 1:
            return pool[0]
        if key not in self.preferences:
            self.preferences[key] = self.rng.sample(pool, len(PREFERENCE_WEIGHTS))
        return self.rng.choices(self.preferences[key], weights=PREFERENCE_WEIGHTS)[0]

    # ----- rows --------------------------------------------------------------------
    def add_row(self, inst: dict, *, day: date, firm, category: str, amount: float, description: str,
                quantity: float | None = None, unit: str | None = None, object_ref: str = "",
                status: str = "izvršeno", tag: str | None = None) -> dict:
        row = {
            "date": day, "firm": firm, "category": category, "amount": round(amount, 2),
            "description": description, "quantity": quantity, "unit": unit, "object_ref": object_ref,
            "status": status, "tag": tag,
        }
        self.rows[inst["id"]].append(row)
        return row

    def describe(self, category: str, qty: float | None, day: date) -> tuple[str, str]:
        """Return (description, object_ref) for a normal payment."""
        month = MONTHS_SR[day.month - 1]
        if category == "painting":
            return f"Krečenje učionica i hodnika, {qty:.0f} m2", ""
        if category == "laptop":
            return f"Laptop {self.rng.choice(LAPTOP_MODELS)}, {qty:.0f} kom", ""
        if category == "desktop_pc":
            return f"Desktop računar i5/16GB, {qty:.0f} kom", ""
        if category == "toner":
            return f"Toner {self.rng.choice(TONER_MODELS)}, {qty:.0f} kom", ""
        if category == "gloves":
            return f"Nitrilne rukavice M, {qty:.0f} kutija x100", ""
        if category == "office_paper":
            return f"Papir A4 80g, {qty:.0f} rismi", ""
        if category == "fuel":
            return f"Gorivo eurodizel, {qty:.0f} l", ""
        if category == "road_repair":
            street = f"Ulica {self.rng.choice(['Jorgovana', 'Ruža', 'Lala', 'Breza', 'Topola', 'Kestena', 'Bagrema', 'Javora', 'Lipa', 'Jasena', 'Hrasta', 'Vrba', 'Dunja', 'Višanja', 'Šljiva', 'Oraha'])}"
            return f"Sanacija udarnih rupa, {street}, {qty:.0f} m2", street
        if category == "cleaning_services":
            return f"Čišćenje prostorija za {month}", ""
        if category == "canteen_food":
            return f"Namirnice za školsku kuhinju, {month}", ""
        if category == "electricity":
            return f"Električna energija za {month}", ""
        if category == "water_utilities":
            return f"Voda i odvoz smeća za {month}", ""
        return self.rng.choice(TEXT_CHOICES[category]), ""

    def random_day(self, year: int, december_weight: float = 1.0) -> date:
        weights = [1.0] * 11 + [december_weight]
        month = self.rng.choices(range(1, 13), weights=weights)[0]
        start = date(year, month, 1)
        end = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1))
        return random_date(self.rng, start, end)

    def generate_background(self) -> None:
        town_iter = 0
        for kind, count in KIND_COUNTS.items():
            for idx in range(count):
                town = TOWNS[(town_iter + idx) % len(TOWNS)]
                inst = {
                    "id": f"{kind[:2].upper()}{idx + 1:02d}",
                    "name": institution_name(kind, idx, town),
                    "kind": kind,
                    "municipality": town,
                }
                self.institutions.append(inst)
                for year in YEARS:
                    self.generate_year(inst, year)
            town_iter += 3

    def generate_year(self, inst: dict, year: int) -> None:
        actual_by_category: dict[str, float] = defaultdict(float)
        for category, count_range, mode, params in KIND_SPECS[inst["kind"]]:
            if mode == "monthly":
                firm = self.pick_vendor(inst["id"], category)
                for month in range(1, 13):
                    day = date(year, month, self.rng.randint(5, 15))
                    amount = self.rng.uniform(*params)
                    desc, obj = self.describe(category, None, day)
                    self.add_row(inst, day=day, firm=firm, category=category, amount=round(amount), description=desc)
                continue
            n = self.rng.randint(*count_range)
            for _ in range(n):
                december_weight = 1.3 if category in PLANNED_CATEGORIES else 1.0
                day = self.random_day(year, december_weight)
                firm = self.pick_vendor(inst["id"], category)
                if mode == "unit":
                    qmin, qmax, pmin, pmax = params
                    if category == "excursion":
                        dest, days = self.rng.choice(DESTINATIONS)
                        students = self.rng.randint(qmin // 2, qmax // 2)
                        qty = students * days
                        unit_price = self.rng.uniform(pmin, pmax)
                        desc = f"Ekskurzija {dest}, {days} dana, {students} učenika"
                        obj = ""
                    else:
                        qty = self.rng.randint(qmin, qmax)
                        unit_price = self.rng.uniform(pmin, pmax)
                        desc, obj = self.describe(category, qty, day)
                    amount = round(qty * unit_price)
                    self.add_row(inst, day=day, firm=firm, category=category, amount=amount, description=desc,
                                 quantity=qty, unit=unit_for(category), object_ref=obj)
                else:
                    amount = round(self.rng.uniform(*params))
                    desc, obj = self.describe(category, None, day)
                    self.add_row(inst, day=day, firm=firm, category=category, amount=amount, description=desc)
                actual_by_category[category] += amount
        for category, actual in actual_by_category.items():
            if category in PLANNED_CATEGORIES:
                planned = round(actual * self.rng.uniform(1.08, 1.35), -4)
                self.plans.append({"institution_id": inst["id"], "category": category, "year": year,
                                   "planned": planned})

    # ----- injected test cases -----------------------------------------------------
    def inst(self, inst_id: str) -> dict:
        return next(i for i in self.institutions if i["id"] == inst_id)

    def inject(self) -> list[dict]:
        """Inject test cases with known signals. Returns ground-truth entries (with row tags)."""
        rng, reg = self.rng, self.registry
        truth: list[dict] = []

        # T01-T03: school Y (split payments, overpriced painting, one agency for all excursions)
        school = self.inst("SC03")
        fixer = self.pick_vendor(school["id"], "maintenance")
        for d in (3, 9, 14, 21, 27):
            self.add_row(school, day=date(2025, 3, d), firm=fixer, category="maintenance", amount=98000,
                         description="Održavanje", tag="T01")
        truth.append(dict(id="T01", title="Five payments of 98,000 RSD to one firm in a month (board threshold 100,000)",
                          primarySignal="SPLIT", expectedSignals=["SPLIT"], payerId=school["id"],
                          recipientId=fixer.id))
        painter = self.pick_vendor(school["id"], "painting")
        self.add_row(school, day=date(2025, 7, 18), firm=painter, category="painting", amount=round(480 * 1050),
                     description="Krečenje učionica i hodnika, 480 m2", quantity=480, unit="m2", tag="T02")
        truth.append(dict(id="T02", title="Painting per m2 more than twice the price paid by other schools",
                          primarySignal="PEER_PRICE", expectedSignals=["PEER_PRICE"], payerId=school["id"],
                          recipientId=painter.id))
        agency = self.pool("excursion")[0]
        for row in self.rows[school["id"]]:
            if row["category"] == "excursion":
                row["firm"] = agency
                row["tag"] = "T03"
        truth.append(dict(id="T03", title="The same travel agency organizes every excursion of the school",
                          primarySignal="CONCENTRATION", expectedSignals=["CONCENTRATION"], payerId=school["id"],
                          recipientId=agency.id))

        # T04: overpriced excursion (example from the spec: Kopaonik, 2 days, 45 students, 36,000 EUR)
        school = self.inst("SC08")
        agency = self.pick_vendor(school["id"], "excursion")
        self.add_row(school, day=date(2025, 5, 12), firm=agency, category="excursion",
                     amount=round(36000 * EUR_TO_RSD), description="Ekskurzija Kopaonik, 2 dana, 45 učenika",
                     quantity=90, unit="student_day", tag="T04")
        truth.append(dict(id="T04", title="Two-day excursion to Kopaonik at 800 EUR per student",
                          primarySignal="PEER_PRICE", expectedSignals=["PEER_PRICE", "MARKET_PRICE"],
                          payerId=school["id"], recipientId=agency.id))

        # T05: health center pays gloves three times more than peers
        hc = self.inst("HE02")
        supplier = self.pick_vendor(hc["id"], "gloves")
        self.add_row(hc, day=date(2025, 9, 8), firm=supplier, category="gloves", amount=150 * 2350,
                     description="Nitrilne rukavice M, 150 kutija x100", quantity=150, unit="box", tag="T05")
        truth.append(dict(id="T05", title="Gloves at three times the price other health centers pay",
                          primarySignal="PEER_PRICE", expectedSignals=["PEER_PRICE"], payerId=hc["id"],
                          recipientId=supplier.id))

        # T06: expense without a clear purpose
        ut = self.inst("UT01")
        firm = self.pick_vendor(ut["id"], "other")
        self.add_row(ut, day=date(2025, 11, 20), firm=firm, category="other", amount=400000,
                     description="Razne usluge", tag="T06")
        truth.append(dict(id="T06", title='"Various services" for 400,000 RSD',
                          primarySignal="VAGUE_PURPOSE", expectedSignals=["VAGUE_PURPOSE"], payerId=ut["id"],
                          recipientId=firm.id))

        # T07: identical round monthly amounts
        ut = self.inst("UT04")
        firm = reg.new_firm("maintenance", name="Servis Plus d.o.o.")
        for month in range(1, 13):
            self.add_row(ut, day=date(2025, month, 2), firm=firm, category="maintenance", amount=50000,
                         description="Održavanje", tag="T07")
        truth.append(dict(id="T07", title="Exactly 50,000 RSD every month for 'maintenance'",
                          primarySignal="ROUND_REPEATED", expectedSignals=["ROUND_REPEATED", "VAGUE_PURPOSE"],
                          payerId=ut["id"], recipientId=firm.id))

        # T08: year-end spike in equipment spending
        lc = self.inst("LO03")
        for d, amount, item in ((4, 168000, "Kancelarijski nameštaj"), (11, 192000, "Klima uređaji"),
                                (18, 176000, "Ozvučenje za salu"), (23, 189000, "Laptop i projektor")):
            firm = self.pick_vendor(lc["id"], "equipment")
            self.add_row(lc, day=date(2025, 12, d), firm=firm, category="equipment", amount=amount,
                         description=item, tag="T08")
        truth.append(dict(id="T08", title="More than half of the annual equipment budget spent in December",
                          primarySignal="YEAR_END_SPIKE", expectedSignals=["YEAR_END_SPIKE"], payerId=lc["id"],
                          recipientId=None))

        # T09: catering company paid for computers
        lc = self.inst("LO05")
        caterer = reg.new_firm("laptop", name="Gurman Plus d.o.o.", activity_category="canteen_food")
        caterer.activity_code, caterer.activity = "56.10", "Restaurants and mobile food service activities"
        self.add_row(lc, day=date(2025, 6, 16), firm=caterer, category="laptop", amount=3 * 96500,
                     description="Laptop Dell Latitude 3540, 3 kom", quantity=3, unit="piece", tag="T09")
        truth.append(dict(id="T09", title="A restaurant company paid for laptops",
                          primarySignal="UNUSUAL_RECIPIENT", expectedSignals=["UNUSUAL_RECIPIENT"],
                          payerId=lc["id"], recipientId=caterer.id))

        # T10: brand-new company receives large consulting payments
        hc = self.inst("HE05")
        newco = reg.new_firm("consulting", name="Nova Linija Konsalting d.o.o.", founded_on="2025-03-02")
        self.add_row(hc, day=date(2025, 3, 20), firm=newco, category="consulting", amount=1450000,
                     description="Konsultantske usluge za unapređenje poslovanja", tag="T10")
        self.add_row(hc, day=date(2025, 5, 28), firm=newco, category="consulting", amount=980000,
                     description="Konsultantske usluge - druga faza", tag="T10")
        truth.append(dict(id="T10", title="Company founded 18 days before its first large payment",
                          primarySignal="NEW_RECIPIENT", expectedSignals=["NEW_RECIPIENT"], payerId=hc["id"],
                          recipientId=newco.id))

        # T11: spent more than planned
        school = self.inst("SC12")
        self.plans = [p for p in self.plans if not (p["institution_id"] == school["id"]
                                                    and p["category"] == "teaching_materials" and p["year"] == 2025)]
        spent_2025 = sum(r["amount"] for r in self.rows[school["id"]]
                         if r["category"] == "teaching_materials" and r["date"].year == 2025)
        self.plans.append({"institution_id": school["id"], "category": "teaching_materials", "year": 2025,
                           "planned": 300000})
        extra = max(0, 520000 - spent_2025)
        firm = self.pick_vendor(school["id"], "teaching_materials")
        for d, part in ((10, 0.55), (24, 0.45)):
            self.add_row(school, day=date(2025, 10, d), firm=firm, category="teaching_materials",
                         amount=round(extra * part), description="Oprema za kabinet informatike", tag="T11")
        truth.append(dict(id="T11", title="Teaching materials: planned 300,000 RSD, spent 520,000 RSD",
                          primarySignal="OVER_PLAN", expectedSignals=["OVER_PLAN"], payerId=school["id"],
                          recipientId=None))

        # T12: overpriced toner at a utility company
        ut = self.inst("UT07")
        firm = self.pick_vendor(ut["id"], "toner")
        self.add_row(ut, day=date(2024, 10, 3), firm=firm, category="toner", amount=12 * 14900,
                     description="Toner HP 85A, 12 kom", quantity=12, unit="piece", tag="T12")
        truth.append(dict(id="T12", title="Toner at about three times the usual price",
                          primarySignal="PEER_PRICE", expectedSignals=["PEER_PRICE"], payerId=ut["id"],
                          recipientId=firm.id))

        # ----- clean controls: unusual-looking but legitimate --------------------------
        ut = self.inst("UT02")
        landlord = reg.new_firm("rent", name="Poslovni Centar Lipa d.o.o.")
        for year in YEARS:
            for month in range(1, 13):
                self.add_row(ut, day=date(year, month, 1), firm=landlord, category="rent", amount=60000,
                             description=f"Zakup poslovnog prostora za {MONTHS_SR[month - 1]} {year}, po ugovoru o zakupu",
                             tag="C01")
        truth.append(dict(id="C01", clean=True, title="Monthly office rent under a lease contract",
                          payerId=ut["id"], recipientId=landlord.id))
        hc = self.inst("HE07")
        firm = self.pick_vendor(hc["id"], "medical_consumables")
        self.add_row(hc, day=date(2025, 2, 14), firm=firm, category="medical_consumables", amount=880000,
                     description="Test trake za glukozu, godišnja zaliha za 1.200 pacijenata sa dijabetesom",
                     tag="C02")
        truth.append(dict(id="C02", clean=True, title="Large but well described annual stock purchase",
                          payerId=hc["id"], recipientId=firm.id))
        return truth

    # ----- output ------------------------------------------------------------------
    def write(self) -> dict[str, list[str]]:
        """Write raw CSV ledgers and plans. Returns tag -> payment ids."""
        out_dir = RAW / "ledgers"
        out_dir.mkdir(parents=True, exist_ok=True)
        tags: dict[str, list[str]] = defaultdict(list)
        for inst in self.institutions:
            rows = sorted(self.rows[inst["id"]], key=lambda r: r["date"])
            with open(out_dir / f"{inst['id']}.csv", "w", encoding="utf-8", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=LEDGER_COLUMNS, delimiter=";")
                writer.writeheader()
                for rb, row in enumerate(rows, start=1):
                    writer.writerow({
                        "rb": rb,
                        "datum": row["date"].strftime("%d.%m.%Y"),
                        "naziv_primaoca": row["firm"].name,
                        "pib_primaoca": row["firm"].id,
                        "iznos": format_rsd(row["amount"]),
                        "vrsta_troska": CATEGORY_TO_EXPENSE_TYPE[row["category"]],
                        "opis": row["description"],
                        "kolicina": format_rsd(row["quantity"]) if row["quantity"] is not None else "",
                        "jedinica_mere": UNIT_TO_UNIT_LABEL.get(row["unit"], "") if row["unit"] else "",
                        "objekat": row["object_ref"],
                        "status": row["status"],
                    })
                    pid = ledger_payment_id(inst["id"], rb)
                    tags[row["tag"] or "_untagged"].append(pid)
        with open(out_dir / "plans.csv", "w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=["ustanova", "vrsta_troska", "godina", "planirano"], delimiter=";")
            writer.writeheader()
            for p in self.plans:
                writer.writerow({"ustanova": p["institution_id"],
                                 "vrsta_troska": CATEGORY_TO_EXPENSE_TYPE[p["category"]],
                                 "godina": p["year"], "planirano": format_rsd(p["planned"])})
        return tags


def unit_for(category: str) -> str | None:
    return {"excursion": "student_day", "painting": "m2", "road_repair": "m2", "laptop": "piece",
            "desktop_pc": "piece", "toner": "piece", "gloves": "box", "office_paper": "ream",
            "fuel": "liter"}.get(category)
