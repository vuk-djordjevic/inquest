"""Download real Serbian procurement data (OCDS) into data/raw/real/.

Source: OCP Data Registry, "Serbia: OpenTender" (publication 139), compiled by the
Government Transparency Institute from the national Public Procurement Portal
(jnportal.ujn.gov.rs). Coverage: July 2020 - May 2022. License: CC BY-NC-SA 4.0.
https://data.open-contracting.org/en/publication/139

    python data/prep/fetch_real.py            # 2021 (a full year, about 64,000 awards)
    python data/prep/fetch_real.py 2020 2022  # several years
    python data/prep/fetch_real.py full       # everything

Then rebuild the database:  npm run data
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

URL = "https://data.open-contracting.org/en/publication/139/download?name={name}.jsonl.gz"
TARGET = Path(__file__).resolve().parents[1] / "raw" / "real"
ALLOWED = {"2020", "2021", "2022", "full"}


def fetch(name: str) -> Path:
    TARGET.mkdir(parents=True, exist_ok=True)
    out = TARGET / f"serbia-opentender-{name}.jsonl.gz"
    if out.exists():
        print(f"already downloaded: {out}")
        return out
    request = urllib.request.Request(URL.format(name=name), headers={"User-Agent": "inquest-data-prep"})
    print(f"downloading {name} ...")
    with urllib.request.urlopen(request, timeout=600) as response, open(str(out) + ".part", "wb") as f:
        while chunk := response.read(1 << 20):
            f.write(chunk)
    Path(str(out) + ".part").rename(out)
    print(f"saved {out} ({out.stat().st_size / 1e6:.1f} MB)")
    return out


def main() -> None:
    names = sys.argv[1:] or ["2021"]
    for name in names:
        if name not in ALLOWED:
            sys.exit(f"unknown dataset '{name}', choose from {sorted(ALLOWED)}")
    for name in names:
        fetch(name)
    print("now run: npm run data")


if __name__ == "__main__":
    main()
