"""Shared helpers for the one-off data preparation scripts.

Everything in this folder is plain Python 3 standard library so that the data
can be rebuilt on any machine without installing packages.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
RAW = DATA / "raw"
REFERENCE = DATA / "reference"
TRUTH = DATA / "truth"
REGISTRY = DATA / "registry"

YEARS = (2024, 2025)

with open(REFERENCE / "categories.json", encoding="utf-8") as fh:
    REF = json.load(fh)

CATEGORIES: dict = REF["categories"]
EUR_TO_RSD: float = REF["eurToRsd"]

# NACE-like activity per category: used for the fictional business registry so
# the Recipient network agent can check whether a recipient's registered
# activity matches what it was paid for.
ACTIVITY_BY_CATEGORY = {
    "excursion": ("79.12", "Tour operator activities"),
    "painting": ("43.34", "Painting and glazing"),
    "road_repair": ("42.11", "Construction of roads and motorways"),
    "laptop": ("46.51", "Wholesale of computers, computer peripheral equipment and software"),
    "desktop_pc": ("46.51", "Wholesale of computers, computer peripheral equipment and software"),
    "toner": ("46.66", "Wholesale of other office machinery and equipment"),
    "gloves": ("46.46", "Wholesale of pharmaceutical and medical goods"),
    "office_paper": ("46.49", "Wholesale of other household goods (stationery)"),
    "fuel": ("47.30", "Retail sale of automotive fuel"),
    "maintenance": ("43.29", "Other construction installation and maintenance"),
    "cleaning_services": ("81.21", "General cleaning of buildings"),
    "consulting": ("70.22", "Business and other management consultancy activities"),
    "it_services": ("62.02", "Computer consultancy activities"),
    "street_lighting": ("43.21", "Electrical installation"),
    "events": ("82.30", "Organisation of conventions and trade shows"),
    "equipment": ("46.65", "Wholesale of office furniture and equipment"),
    "teaching_materials": ("47.61", "Retail sale of books and teaching aids"),
    "medical_consumables": ("46.46", "Wholesale of pharmaceutical and medical goods"),
    "canteen_food": ("46.39", "Non-specialised wholesale of food"),
    "rent": ("68.20", "Renting and operating of own or leased real estate"),
    "electricity": ("35.13", "Distribution of electricity"),
    "water_utilities": ("36.00", "Water collection, treatment and supply"),
    "other": ("82.99", "Other business support service activities"),
}

NAME_STEMS = [
    "Alfa", "Beta", "Delta", "Sigma", "Omega", "Nova", "Prima", "Maxi", "Euro", "Vita",
    "Lux", "Grand", "Orion", "Atlas", "Zenit", "Kvant", "Polar", "Tera", "Neo", "Fokus",
    "Mega", "Tim", "Pro", "Iskra", "Sunce", "Duga", "Kristal", "Most", "Javor", "Lipa",
]

NAME_SUFFIX_BY_CATEGORY = {
    "excursion": "Travel", "painting": "Kolor", "road_repair": "Gradnja", "laptop": "Tech",
    "desktop_pc": "Komp", "toner": "Print", "gloves": "Med", "office_paper": "Papir",
    "fuel": "Petrol", "maintenance": "Servis", "cleaning_services": "Higijena",
    "consulting": "Konsalting", "it_services": "Soft", "street_lighting": "Elektro",
    "events": "Event", "equipment": "Oprema", "teaching_materials": "Knjiga",
    "medical_consumables": "Medika", "canteen_food": "Hrana", "rent": "Nekretnine",
    "electricity": "Energija", "water_utilities": "Vodovod", "other": "Usluge",
}


@dataclass
class Firm:
    id: str
    name: str
    category: str
    founded_on: str
    activity_code: str
    activity: str
    city: str


@dataclass
class FirmRegistry:
    """Fictional business registry (stands in for a public company register).

    It is NOT loaded into the payments database. Agents can only reach it
    through the registry lookup tool, exactly like they would query a real
    public register, and every answer carries a source link.
    """

    rng: random.Random
    firms: dict[str, Firm] = field(default_factory=dict)
    used_names: set[str] = field(default_factory=set)
    next_pib: int = 900_000_001

    def new_firm(self, category: str, *, name: str | None = None, founded_on: str | None = None,
                 activity_category: str | None = None, city: str = "Fiktivgrad") -> Firm:
        if name is None:
            suffix = NAME_SUFFIX_BY_CATEGORY[category]
            for _ in range(200):
                candidate = f"{self.rng.choice(NAME_STEMS)} {suffix} d.o.o."
                if candidate not in self.used_names:
                    name = candidate
                    break
            else:  # pragma: no cover - only with absurdly many firms
                name = f"{suffix} {self.next_pib} d.o.o."
        self.used_names.add(name)
        if founded_on is None:
            founded_on = random_date(self.rng, date(2003, 1, 1), date(2019, 12, 31)).isoformat()
        code, activity = ACTIVITY_BY_CATEGORY[activity_category or category]
        firm = Firm(id=str(self.next_pib), name=name, category=category, founded_on=founded_on,
                    activity_code=code, activity=activity, city=city)
        self.next_pib += 7  # keep ids non-contiguous
        self.firms[firm.id] = firm
        return firm

    def to_json(self) -> list[dict]:
        return [
            {
                "id": f.id,
                "name": f.name,
                "foundedOn": f.founded_on,
                "activityCode": f.activity_code,
                "activity": f.activity,
                "city": f.city,
                "status": "active",
                "sourceUrl": f"registry://fictional-business-register/{f.id}",
            }
            for f in self.firms.values()
        ]


def random_date(rng: random.Random, start: date, end: date) -> date:
    return start + timedelta(days=rng.randint(0, (end - start).days))


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
