"""Adapter: OCDS (Open Contracting Data Standard) -> common payment model.

Works with any OCDS 1.1 release package, record package (compiled releases),
or a JSON-lines file of releases. Tested with the synthetic package produced by
gen_procurement.py; the same code is meant to run on real publications from the
OCDS data registry (https://data.open-contracting.org/).

Each contract becomes one payment. An award without a contract (for example a
cancelled award) also becomes a payment with status 'cancelled', so that the
agents can see it, but the verifier can exclude it from counts.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from common import CATEGORIES, EUR_TO_RSD

UNIT_ALIASES = {
    "kom": "piece", "komad": "piece", "piece": "piece", "pieces": "piece", "unit": "piece", "each": "piece",
    "m2": "m2", "m²": "m2", "square metre": "m2", "square meter": "m2",
    "litar": "liter", "l": "liter", "liter": "liter", "litre": "liter",
    "risma": "ream", "ream": "ream", "kutija": "box", "box": "box",
}
CANCELLED_AWARD_STATUSES = {"cancelled", "unsuccessful"}


def _cpv_prefixes() -> list[tuple[str, str]]:
    """(cpv prefix, category) sorted from most to least specific."""
    pairs = []
    for category, spec in CATEGORIES.items():
        for code in spec.get("cpv", []):
            pairs.append((code.rstrip("0") or code, category))
    return sorted(pairs, key=lambda p: -len(p[0]))


CPV_PREFIXES = _cpv_prefixes()


def category_for_cpv(cpv: str | None) -> str:
    if not cpv:
        return "other"
    code = cpv.split("-")[0]
    for prefix, category in CPV_PREFIXES:
        if code.startswith(prefix):
            return category
    return "other"


def iter_releases(path: Path) -> Iterator[dict]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".jsonl":
        for line in text.splitlines():
            if line.strip():
                yield json.loads(line)
        return
    data = json.loads(text)
    if isinstance(data, list):
        yield from data
    elif "releases" in data:
        yield from data["releases"]
    elif "records" in data:
        for record in data["records"]:
            if "compiledRelease" in record:
                yield record["compiledRelease"]
            elif record.get("releases"):
                yield record["releases"][-1]


def _party_identifier(release: dict, party_ref: dict) -> tuple[str, str]:
    """Return (stable id, name) for a party reference; prefers the legal identifier (e.g. PIB)."""
    parties = {p.get("id"): p for p in release.get("parties", [])}
    party = parties.get(party_ref.get("id"), {})
    ident = party.get("identifier", {}).get("id")
    return str(ident or party_ref.get("id")), party_ref.get("name") or party.get("name", "")


def _to_rsd(value: dict | None) -> float | None:
    if not value or value.get("amount") is None:
        return None
    amount = float(value["amount"])
    if value.get("currency") == "EUR":
        return amount * EUR_TO_RSD
    return amount


def _date(text: str | None) -> str | None:
    return text[:10] if text else None


def ocds_payment_id(release: dict, contract_or_award_id: str | None = None) -> str:
    """Stable payment id; without an explicit id, refers to the first contract (or award)."""
    if contract_or_award_id is None:
        if release.get("contracts"):
            contract_or_award_id = release["contracts"][0]["id"]
        else:
            contract_or_award_id = release["awards"][0]["id"]
    return f"{release['ocid']}/{contract_or_award_id}"


def adapt_release(release: dict, source_file: str) -> tuple[list[dict], list[dict], dict]:
    """Translate one compiled release. Returns (payments, procurement contexts, buyer institution)."""
    buyer_ref = release.get("buyer") or {}
    buyer = {"id": str(buyer_ref.get("id")), "name": buyer_ref.get("name", ""), "kind": "municipality",
             "municipality": ""}
    tender = release.get("tender", {})
    items = tender.get("items", [])
    item = next((i for i in items if i.get("quantity")), items[0] if items else {})
    cpv = (item.get("classification") or {}).get("id")
    category = category_for_cpv(cpv)
    unit_name = ((item.get("unit") or {}).get("name") or "").strip().lower()
    unit = UNIT_ALIASES.get(unit_name)
    description = item.get("description") or tender.get("title") or ""
    object_ref = (item.get("deliveryAddress") or {}).get("streetAddress")

    bids = []
    for bid in (release.get("bids") or {}).get("details", []):
        tenderer = (bid.get("tenderers") or [{}])[0]
        bidder_id, bidder_name = _party_identifier(release, tenderer)
        bids.append({"bidderId": bidder_id, "bidderName": bidder_name, "amount": _to_rsd(bid.get("value"))})

    contracts_by_award = {c.get("awardID"): c for c in release.get("contracts", [])}
    payments, contexts = [], []
    for award in release.get("awards", []):
        contract = contracts_by_award.get(award.get("id"))
        supplier_ref = (award.get("suppliers") or [{}])[0]
        supplier_id, supplier_name = _party_identifier(release, supplier_ref)
        award_value = _to_rsd(award.get("value"))
        final_value = _to_rsd(contract.get("value")) if contract else award_value
        cancelled = contract is None and award.get("status") in CANCELLED_AWARD_STATUSES
        pid = ocds_payment_id(release, contract["id"] if contract else award["id"])
        quantity = float(item["quantity"]) if item.get("quantity") else None
        payments.append({
            "id": pid,
            "payer_id": buyer["id"],
            "payer_name": buyer["name"],
            "payer_kind": buyer["kind"],
            "recipient_id": supplier_id,
            "recipient_name": supplier_name,
            "amount": final_value or 0.0,
            "currency": "RSD",
            "date": _date(contract.get("dateSigned") if contract else award.get("date")) or _date(release.get("date")),
            "category": category,
            "description": description,
            "quantity": quantity,
            "unit": unit,
            "object_ref": object_ref,
            "source": "procurement",
            "source_ref": f"ocds://{source_file}#{pid}",
            "source_record": json.dumps(release, ensure_ascii=False),
            "status": "cancelled" if cancelled else "completed",
        })
        period = tender.get("tenderPeriod") or {}
        contexts.append({
            "payment_id": pid,
            "ocid": release["ocid"],
            "procedure_type": tender.get("procurementMethod"),
            "procedure_details": tender.get("procurementMethodDetails"),
            "contract_kind": tender.get("mainProcurementCategory"),
            "estimated_value": _to_rsd(tender.get("value")),
            "tender_start": _date(period.get("startDate")),
            "tender_end": _date(period.get("endDate")),
            "bids_count": tender.get("numberOfTenderers", len(bids) or None),
            "bids_json": json.dumps(bids, ensure_ascii=False),
            "original_value": award_value,
            "final_value": final_value,
            "amendments_json": json.dumps((contract or {}).get("amendments", []), ensure_ascii=False),
        })
    return payments, contexts, buyer


def adapt_file(path: Path) -> tuple[list[dict], list[dict], dict[str, dict]]:
    payments, contexts, buyers = [], [], {}
    for release in iter_releases(path):
        p, c, b = adapt_release(release, path.name)
        payments.extend(p)
        contexts.extend(c)
        buyers[b["id"]] = b
    return payments, contexts, buyers
