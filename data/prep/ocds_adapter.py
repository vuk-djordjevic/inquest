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

import gzip
import json
import re
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


def _open_text(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open(encoding="utf-8")


def iter_releases(path: Path) -> Iterator[dict]:
    """Releases from .json / .jsonl, optionally gzip-compressed (.json.gz, .jsonl.gz)."""
    if path.name.endswith((".jsonl", ".jsonl.gz")):
        with _open_text(path) as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)
        return
    with _open_text(path) as f:
        data = json.load(f)
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
    """Return (stable id, name) for a party reference; prefers the legal identifier (e.g. PIB).

    Publishers differ: some use `identifier`, OpenTender puts the national id in
    `additionalIdentifiers` with scheme ORGANIZATION_ID.
    """
    parties = {p.get("id"): p for p in release.get("parties", [])}
    party = parties.get(party_ref.get("id"), {})
    ident = (party.get("identifier") or {}).get("id")
    if not ident:
        ident = next((a.get("id") for a in party.get("additionalIdentifiers", [])
                      if a.get("scheme") == "ORGANIZATION_ID" and a.get("id")), None)
    return str(ident or party_ref.get("id")), party_ref.get("name") or party.get("name", "")


# Buyer kind from its name (Serbian, Cyrillic or Latin). Used for peer groups.
_KIND_PATTERNS = [
    ("school", r"школ|škol|гимназиј|gimnazij|вртић|vrtić|предшколск|predškolsk|факултет|fakultet|универзитет|univerzitet"),
    ("health_center", r"дом здрављ|dom zdravlj|болниц|bolnic|клиник|klinik|здравствен|zdravstven|апотек|apotek"),
    ("utility", r"комунал|komunal|јкп|jkp|водовод|vodovod|топлан|toplan|чистоћ|čistoć"),
    ("municipality", r"општин|opštin|opstin|градск|gradsk|^град |^grad |месна заједниц|mesna zajednic"),
]


def buyer_kind(name: str) -> str:
    lowered = name.lower()
    for kind, pattern in _KIND_PATTERNS:
        if re.search(pattern, lowered):
            return kind
    return "other"


def _to_rsd(value: dict | None) -> float | None:
    """Amount in RSD. A missing currency is read as RSD (national portals); other currencies are skipped."""
    if not value or value.get("amount") is None:
        return None
    amount = float(value["amount"])
    currency = value.get("currency")
    if currency == "EUR":
        return amount * EUR_TO_RSD
    if currency in (None, "RSD"):
        return amount
    return None


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


def _bids_per_lot(release: dict) -> dict[str | None, int]:
    """Number of bids per lot from the bid statistics (OCDS bid extension), if published."""
    out: dict[str | None, int] = {}
    for stat in (release.get("bids") or {}).get("statistics", []):
        if stat.get("measure") in ("bids", "validBids", "electronicBids") and stat.get("value") is not None:
            lot = stat.get("relatedLot")
            # Prefer the general "bids" measure when a publisher gives several.
            if stat["measure"] == "bids" or lot not in out:
                out[lot] = int(stat["value"])
    return out


def _tender_start(tender: dict) -> str | None:
    period = tender.get("tenderPeriod") or {}
    if period.get("startDate"):
        return _date(period["startDate"])
    # Some publishers give only the deadline; the tender notice publication date is the start.
    notices = [d.get("datePublished") for d in tender.get("documents", [])
               if d.get("documentType") == "tenderNotice" and d.get("datePublished")]
    return _date(min(notices)) if notices else None


def adapt_release(release: dict, source_file: str) -> tuple[list[dict], list[dict], dict]:
    """Translate one compiled release. Returns (payments, procurement contexts, buyer institution)."""
    buyer_ref = release.get("buyer") or {}
    buyer_id, buyer_name = _party_identifier(release, buyer_ref) if buyer_ref else ("", "")
    buyer = {"id": buyer_id, "name": buyer_name, "kind": buyer_kind(buyer_name), "municipality": ""}
    tender = release.get("tender", {})
    items = tender.get("items", [])
    item = next((i for i in items if i.get("quantity")), items[0] if items else {})
    cpv = (item.get("classification") or {}).get("id")
    category = category_for_cpv(cpv)
    unit_name = ((item.get("unit") or {}).get("name") or "").strip().lower()
    unit = UNIT_ALIASES.get(unit_name)
    object_ref = (item.get("deliveryAddress") or {}).get("streetAddress")
    lots = {lot.get("id"): lot for lot in tender.get("lots", [])}
    bids_per_lot = _bids_per_lot(release)

    bids = []
    for bid in (release.get("bids") or {}).get("details", []):
        tenderer = (bid.get("tenderers") or [{}])[0]
        bidder_id, bidder_name = _party_identifier(release, tenderer)
        bids.append({"bidderId": bidder_id, "bidderName": bidder_name, "amount": _to_rsd(bid.get("value")),
                     "lots": bid.get("relatedLots") or []})

    contracts_by_award = {c.get("awardID"): c for c in release.get("contracts", [])}
    payments, contexts = [], []
    for award in release.get("awards", []):
        contract = contracts_by_award.get(award.get("id"))
        supplier_ref = (award.get("suppliers") or [{}])[0]
        supplier_id, supplier_name = _party_identifier(release, supplier_ref)
        award_value = _to_rsd(award.get("value"))
        contract_value = _to_rsd(contract.get("value")) if contract and contract.get("value") else None
        final_value = contract_value if contract_value is not None else award_value
        if final_value is None and (award.get("value") or {}).get("amount") is not None:
            continue  # value in a currency we cannot convert
        cancelled = contract is None and award.get("status") in CANCELLED_AWARD_STATUSES
        pid = ocds_payment_id(release, contract["id"] if contract else award["id"])
        quantity = float(item["quantity"]) if item.get("quantity") else None
        lot_ids = award.get("relatedLots") or []
        lot = lots.get(lot_ids[0]) if lot_ids else None
        description = item.get("description") or (lot or {}).get("title") or tender.get("title") or ""
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
        # Bids for this award's lot. Bid details may list only the winning bid, so a
        # published bid count (tender.numberOfTenderers or bid statistics) wins over counting details.
        lot_bids = [b for b in bids if not lot_ids or not b["lots"] or set(b["lots"]) & set(lot_ids)]
        published = next((bids_per_lot[l] for l in lot_ids if l in bids_per_lot), bids_per_lot.get(None))
        bids_count = None if lot_ids else tender.get("numberOfTenderers")
        if bids_count is None:
            bids_count = published if published is not None else (len(lot_bids) or None)
        contexts.append({
            "payment_id": pid,
            "ocid": release["ocid"],
            "procedure_type": tender.get("procurementMethod"),
            "procedure_details": tender.get("procurementMethodDetails"),
            "contract_kind": tender.get("mainProcurementCategory"),
            "estimated_value": _to_rsd((lot or {}).get("value")) or _to_rsd(tender.get("value")),
            "tender_start": _tender_start(tender),
            "tender_end": _date(period.get("endDate")),
            "bids_count": bids_count,
            "bids_json": json.dumps([{k: v for k, v in b.items() if k != "lots"} for b in lot_bids], ensure_ascii=False),
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
