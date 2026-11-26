"""Adapter: institution payment ledgers (CSV) -> common payment model.

Ledgers are exported by schools, health centers, utility companies and local
communities in their own CSV layout (Serbian column names, ';' separator,
Serbian number and date formatting). This adapter is the only place that knows
about that layout; the agents only ever see the common model.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path

# Raw expense type label (as written by the institution) -> normalized category.
EXPENSE_TYPE_TO_CATEGORY = {
    "Ekskurzije i izleti": "excursion",
    "Krečenje i molerski radovi": "painting",
    "Sanacija kolovoza": "road_repair",
    "Računarska oprema - laptopovi": "laptop",
    "Računarska oprema - desktop računari": "desktop_pc",
    "Toneri i kertridži": "toner",
    "Medicinske rukavice": "gloves",
    "Kancelarijski papir": "office_paper",
    "Gorivo": "fuel",
    "Tekuće održavanje": "maintenance",
    "Usluge čišćenja": "cleaning_services",
    "Konsultantske usluge": "consulting",
    "Računarske usluge": "it_services",
    "Organizacija manifestacija": "events",
    "Oprema i nameštaj": "equipment",
    "Nastavna sredstva": "teaching_materials",
    "Medicinski potrošni materijal": "medical_consumables",
    "Namirnice za kuhinju": "canteen_food",
    "Zakup prostora": "rent",
    "Električna energija": "electricity",
    "Komunalne usluge": "water_utilities",
    "Ostali troškovi": "other",
}
CATEGORY_TO_EXPENSE_TYPE = {v: k for k, v in EXPENSE_TYPE_TO_CATEGORY.items()}

UNIT_LABEL_TO_UNIT = {
    "kom": "piece",
    "m2": "m2",
    "učenik-dan": "student_day",
    "kutija": "box",
    "risma": "ream",
    "litar": "liter",
    "": None,
}
UNIT_TO_UNIT_LABEL = {v: k for k, v in UNIT_LABEL_TO_UNIT.items() if v}

STATUS_MAP = {"izvršeno": "completed", "stornirano": "cancelled"}

LEDGER_COLUMNS = [
    "rb", "datum", "naziv_primaoca", "pib_primaoca", "iznos", "vrsta_troska",
    "opis", "kolicina", "jedinica_mere", "objekat", "status",
]


def ledger_payment_id(institution_id: str, rb: int) -> str:
    """Stable payment id used by the common model (and by the ground truth file)."""
    return f"{institution_id}-{rb:05d}"


def parse_rsd(text: str) -> float:
    """Parse Serbian number formatting: '98.000,00' -> 98000.0"""
    text = text.strip()
    if not text:
        return 0.0
    return float(text.replace(".", "").replace(",", "."))


def format_rsd(value: float) -> str:
    """Format a number the way the institutions export it: 98000 -> '98.000,00'"""
    whole, frac = f"{value:,.2f}".split(".")
    return whole.replace(",", ".") + "," + frac


def parse_date(text: str) -> str:
    return datetime.strptime(text.strip(), "%d.%m.%Y").date().isoformat()


def adapt_ledger(csv_path: Path, institution: dict) -> list[dict]:
    """Translate one institution ledger into common-model payment rows."""
    payments: list[dict] = []
    with open(csv_path, encoding="utf-8", newline="") as fh:
        for raw in csv.DictReader(fh, delimiter=";"):
            category = EXPENSE_TYPE_TO_CATEGORY.get(raw["vrsta_troska"].strip(), "other")
            quantity = parse_rsd(raw["kolicina"]) if raw["kolicina"].strip() else None
            payments.append({
                "id": ledger_payment_id(institution["id"], int(raw["rb"])),
                "payer_id": institution["id"],
                "payer_name": institution["name"],
                "payer_kind": institution["kind"],
                "recipient_id": raw["pib_primaoca"].strip(),
                "recipient_name": raw["naziv_primaoca"].strip(),
                "amount": parse_rsd(raw["iznos"]),
                "currency": "RSD",
                "date": parse_date(raw["datum"]),
                "category": category,
                "description": raw["opis"].strip(),
                "quantity": quantity,
                "unit": UNIT_LABEL_TO_UNIT.get(raw["jedinica_mere"].strip()),
                "object_ref": raw["objekat"].strip() or None,
                "source": institution["kind"],
                "source_ref": f"ledger://{csv_path.name}#rb={raw['rb']}",
                "source_record": json.dumps(raw, ensure_ascii=False),
                "status": STATUS_MAP.get(raw["status"].strip(), "completed"),
            })
    return payments


def adapt_budget_plans(csv_path: Path) -> list[dict]:
    """Translate the annual budget plan file (one row per institution, expense type and year)."""
    rows = []
    with open(csv_path, encoding="utf-8", newline="") as fh:
        for raw in csv.DictReader(fh, delimiter=";"):
            rows.append({
                "payer_id": raw["ustanova"].strip(),
                "category": EXPENSE_TYPE_TO_CATEGORY.get(raw["vrsta_troska"].strip(), "other"),
                "year": int(raw["godina"]),
                "planned_amount": parse_rsd(raw["planirano"]),
            })
    return rows
