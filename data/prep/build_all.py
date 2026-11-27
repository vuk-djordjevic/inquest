"""Build the Inquest dataset end to end.

1. Generate synthetic institution ledgers (CSV) and synthetic procurement (OCDS JSON).
2. Run every source through its adapter into the common payment model.
3. Load everything into SQLite (data/inquest.db).
4. Write the ground truth (data/truth/ground_truth.json, never read by agents)
   and the fictional business registry (data/registry/fictional_registry.json,
   only reachable through the registry lookup tool).

Real OCDS files dropped into data/raw/real/ (*.json or *.jsonl) are adapted
and loaded as well, marked with dataset='real'.

Usage:  python data/prep/build_all.py [--seed 42]
"""

from __future__ import annotations

import argparse
import random
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import DATA, RAW, REGISTRY, TRUTH, FirmRegistry, write_json  # noqa: E402
from gen_ledgers import TOWNS, LedgerGenerator  # noqa: E402
from gen_procurement import ProcurementGenerator  # noqa: E402
from ledger_adapter import adapt_budget_plans, adapt_ledger  # noqa: E402
from ocds_adapter import adapt_file  # noqa: E402

SCHEMA = """
CREATE TABLE institutions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,            -- school | health_center | utility | local_community | municipality
    municipality TEXT,
    dataset TEXT NOT NULL          -- synthetic | real
);
CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    payer_id TEXT NOT NULL,
    payer_name TEXT NOT NULL,
    payer_kind TEXT NOT NULL,
    recipient_id TEXT NOT NULL,    -- tax id (PIB) or registry id
    recipient_name TEXT NOT NULL,
    amount REAL NOT NULL,          -- RSD
    currency TEXT NOT NULL,
    date TEXT NOT NULL,            -- ISO date
    category TEXT NOT NULL,
    description TEXT,
    quantity REAL,
    unit TEXT,
    object_ref TEXT,               -- physical object the payment is for (street, building), if known
    source TEXT NOT NULL,          -- procurement | school | health_center | utility | local_community
    source_ref TEXT NOT NULL,      -- pointer to the original record
    source_record TEXT NOT NULL,   -- original record as JSON
    status TEXT NOT NULL,          -- completed | cancelled
    dataset TEXT NOT NULL          -- synthetic | real
);
CREATE INDEX idx_payments_payer ON payments(payer_id, category, date);
CREATE INDEX idx_payments_recipient ON payments(recipient_id, date);
CREATE INDEX idx_payments_category ON payments(category, payer_kind);
CREATE TABLE procurement_context (
    payment_id TEXT PRIMARY KEY REFERENCES payments(id),
    ocid TEXT,
    procedure_type TEXT,           -- OCDS procurementMethod: open | selective | limited | direct
    procedure_details TEXT,
    contract_kind TEXT,            -- goods | services | works
    estimated_value REAL,
    tender_start TEXT,
    tender_end TEXT,
    bids_count INTEGER,
    bids_json TEXT,                -- [{bidderId, bidderName, amount}]
    original_value REAL,
    final_value REAL,
    amendments_json TEXT
);
CREATE TABLE budget_plans (
    payer_id TEXT NOT NULL,
    category TEXT NOT NULL,
    year INTEGER NOT NULL,
    planned_amount REAL NOT NULL,
    PRIMARY KEY (payer_id, category, year)
);
"""

PAYMENT_COLUMNS = ["id", "payer_id", "payer_name", "payer_kind", "recipient_id", "recipient_name", "amount",
                   "currency", "date", "category", "description", "quantity", "unit", "object_ref", "source",
                   "source_ref", "source_record", "status", "dataset"]
CONTEXT_COLUMNS = ["payment_id", "ocid", "procedure_type", "procedure_details", "contract_kind", "estimated_value",
                   "tender_start", "tender_end", "bids_count", "bids_json", "original_value", "final_value",
                   "amendments_json"]


def insert(conn: sqlite3.Connection, table: str, columns: list[str], rows: list[dict]) -> None:
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})"
    conn.executemany(sql, [[row.get(c) for c in columns] for row in rows])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--db", default=str(DATA / "inquest.db"))
    args = parser.parse_args()

    rng = random.Random(args.seed)
    registry = FirmRegistry(rng)

    # 1. Generate raw sources -------------------------------------------------------
    ledgers = LedgerGenerator(rng, registry)
    ledgers.generate_background()
    truth = ledgers.inject()
    ledger_tags = ledgers.write()

    procurement = ProcurementGenerator(rng, registry, ledgers.pool, TOWNS)
    alfa = registry.new_firm("laptop", name="Alfa Tech d.o.o.", founded_on="2019-05-14")
    ledgers.pool("laptop").append(alfa)  # Alfa also sells normally elsewhere
    skip = {("MU03", "laptop"), ("MU03", "desktop_pc"), ("MU03", "toner")}
    truth += procurement.inject(alfa)
    procurement.generate_background(skip)
    truth.append(procurement.inject_noncompetitive())
    procurement_tags = procurement.write()

    # 2. Adapt every source into the common model -----------------------------------
    institutions = {i["id"]: {**i, "dataset": "synthetic"} for i in ledgers.institutions}
    payments, contexts, plans = [], [], []
    for inst in ledgers.institutions:
        payments += adapt_ledger(RAW / "ledgers" / f"{inst['id']}.csv", inst)
    plans += adapt_budget_plans(RAW / "ledgers" / "plans.csv")

    p, c, buyers = adapt_file(RAW / "procurement" / "synthetic_ocds.json")
    payments += p
    contexts += c
    for b in procurement.buyers:
        institutions[b["id"]] = {**b, "dataset": "synthetic"}
    for pay in payments:
        pay.setdefault("dataset", "synthetic")

    real_dir = RAW / "real"
    if real_dir.exists():
        real_files = [f for f in real_dir.iterdir()
                      if f.name.endswith((".json", ".jsonl", ".json.gz", ".jsonl.gz"))]
        for path in sorted(real_files):
            rp, rc, rb = adapt_file(path)
            for pay in rp:
                pay["dataset"] = "real"
            payments += rp
            contexts += rc
            for b in rb.values():
                institutions.setdefault(b["id"], {**b, "dataset": "real"})
            print(f"  real OCDS: {path.name}: {len(rp)} payments")

    # 3. Load SQLite -------------------------------------------------------------------
    db_path = Path(args.db)
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    insert(conn, "institutions", ["id", "name", "kind", "municipality", "dataset"], list(institutions.values()))
    insert(conn, "payments", PAYMENT_COLUMNS, payments)
    insert(conn, "procurement_context", CONTEXT_COLUMNS, contexts)
    insert(conn, "budget_plans", ["payer_id", "category", "year", "planned_amount"], plans)
    conn.commit()

    # 4. Ground truth + registry ----------------------------------------------------
    tags = {**ledger_tags}
    for k, v in procurement_tags.items():
        tags.setdefault(k, []).extend(v)
    for entry in truth:
        entry["paymentIds"] = sorted(tags.get(entry["id"], []))
        assert entry["paymentIds"], f"no payments tagged for {entry['id']}"
    # A random sample of untouched background payments serves as additional clean controls.
    touched = {e["payerId"] for e in truth} | {e.get("recipientId") for e in truth}
    candidates = [pid for pid in tags["_untagged"]]
    by_id = {pay["id"]: pay for pay in payments}
    candidates = [pid for pid in candidates if by_id[pid]["payer_id"] not in touched
                  and by_id[pid]["recipient_id"] not in touched]
    sample = sorted(rng.sample(candidates, 40))
    truth.append(dict(id="C90", clean=True, title="Random sample of untouched background payments",
                      payerId=None, recipientId=None, paymentIds=sample))
    write_json(TRUTH / "ground_truth.json", {
        "_comment": "Ground truth for injected test cases. Agents never read this file; only the evaluator does.",
        "seed": args.seed,
        "cases": truth,
    })
    write_json(REGISTRY / "fictional_registry.json", {
        "_comment": "Fictional business register. Reached only through the registry lookup tool.",
        "companies": registry.to_json(),
    })

    n_real = sum(1 for pay in payments if pay["dataset"] == "real")
    print(f"institutions: {len(institutions)}  payments: {len(payments)} (real: {n_real})  "
          f"procurement contexts: {len(contexts)}  plans: {len(plans)}")
    print(f"injected cases: {sum(1 for t in truth if not t.get('clean'))}  "
          f"clean controls: {sum(len(t['paymentIds']) for t in truth if t.get('clean'))} payments")
    print(f"database: {db_path}")


if __name__ == "__main__":
    main()
