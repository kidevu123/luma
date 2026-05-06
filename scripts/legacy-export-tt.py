#!/usr/bin/env python3
"""Export every table from the TabletTracker MySQL DB to per-table JSON files.

Run inside a PythonAnywhere Bash console with the TabletTracker venv active:

    cd ~/TabletTracker
    source venv/bin/activate
    python ~/tt-export.py        # or whatever path you saved this to

The script imports the Flask app via create_app(), which loads the same
DB config the live webapp uses — so we don't have to know the MySQL
password manually. Output:

    ~/dumps/tt-export/<table>.json     # one file per table
    ~/dumps/tt-export/_manifest.json   # row counts + timestamp
    ~/dumps/tt-export.tar.gz           # tarball of the above (single file
                                       # for Luma's legacy-import fetcher)

The Luma side pulls /home/<user>/dumps/tt-export.tar.gz via the PA Files
API token, untars it, and runs the importer.
"""

from __future__ import annotations

import json
import os
import sys
import tarfile
from datetime import date, datetime, time
from decimal import Decimal


HOME = os.path.expanduser("~")
TT_PATH = os.path.join(HOME, "TabletTracker")
OUT_DIR = os.path.join(HOME, "dumps", "tt-export")
TARBALL = os.path.join(HOME, "dumps", "tt-export.tar.gz")


def _load_app():
    """Locate the Flask app by trying the usual factory/instance patterns.

    If none match, the user's TabletTracker uses a non-standard layout —
    they'll need to edit this function with the right import line.
    """
    sys.path.insert(0, TT_PATH)
    os.chdir(TT_PATH)
    last_err: Exception | None = None
    for mod_name in ("app", "wsgi", "main", "tablettracker", "run"):
        try:
            mod = __import__(mod_name)
        except Exception as err:
            last_err = err
            continue
        if hasattr(mod, "create_app"):
            try:
                return mod.create_app()
            except Exception as err:
                last_err = err
                continue
        if hasattr(mod, "app"):
            return getattr(mod, "app")
    raise RuntimeError(
        "Could not locate the Flask app. Tried import patterns "
        "(app/wsgi/main/tablettracker/run).(create_app|app). "
        f"Last error: {last_err!r}. "
        "Edit _load_app() in this script with the correct entry point."
    )


def _json_safe(value):
    """Coerce types that json.dumps doesn't natively handle."""
    if value is None:
        return None
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.decode("utf-8", errors="replace")
    return value


def main() -> int:
    app = _load_app()

    # Resolve the SQLAlchemy db extension. Flask-SQLAlchemy registers
    # itself under app.extensions['sqlalchemy'].
    try:
        db = app.extensions["sqlalchemy"]
    except KeyError as err:
        raise RuntimeError("Flask-SQLAlchemy isn't loaded on the app.") from err

    from sqlalchemy import inspect, text

    os.makedirs(OUT_DIR, exist_ok=True)

    with app.app_context():
        insp = inspect(db.engine)
        tables = sorted(insp.get_table_names())
        print(f"Found {len(tables)} tables.")

        summary: dict[str, object] = {}
        for table in tables:
            try:
                rows = db.session.execute(
                    text(f"SELECT * FROM `{table}`")
                ).mappings().all()
                data = [{k: _json_safe(v) for k, v in r.items()} for r in rows]
                with open(os.path.join(OUT_DIR, f"{table}.json"), "w") as fh:
                    json.dump(data, fh, default=str)
                summary[table] = len(data)
                print(f"  {table:42s}  {len(data):>6d} rows")
            except Exception as err:  # noqa: BLE001 — best-effort export
                summary[table] = f"err: {err}"
                print(f"  {table:42s}  ERROR: {err}")

        manifest = {
            "exported_at_utc": datetime.utcnow().isoformat() + "Z",
            "tt_path": TT_PATH,
            "tables": summary,
        }
        with open(os.path.join(OUT_DIR, "_manifest.json"), "w") as fh:
            json.dump(manifest, fh, indent=2)

    # Tar+gzip so the Luma fetcher only has to grab one file.
    print(f"\nWriting tarball to {TARBALL}...")
    with tarfile.open(TARBALL, "w:gz") as tar:
        tar.add(OUT_DIR, arcname="tt-export")

    size_mb = os.path.getsize(TARBALL) / (1024 * 1024)
    total_rows = sum(n for n in summary.values() if isinstance(n, int))
    print(
        f"\nDone. {len(tables)} tables, {total_rows} total rows, "
        f"{size_mb:.2f} MB tarball at {TARBALL}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
