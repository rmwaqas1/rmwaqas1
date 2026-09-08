#!/usr/bin/env python3
"""
a2aj_pull.py — pull A2AJ Canadian legal data to local disk and build an
offline DuckDB index with BM25 full-text search.

    pip install duckdb          # only needed for the index step
    python3 a2aj_pull.py                 # default slice (see PROFILE below)
    python3 a2aj_pull.py --all           # everything (~5.1 GB)
    python3 a2aj_pull.py --sets RAD,RPD,FC --no-index
    python3 a2aj_pull.py --dest ~/legal/a2aj

Downloads resume on interrupt. Re-running skips files already complete and
re-pulls any whose size changed upstream.

Querying the index afterwards:

    import duckdb
    con = duckdb.connect(os.path.expanduser("~/a2aj/a2aj.duckdb"))
    con.execute("LOAD fts;")
    con.execute(
        "SELECT citation, style, decided, cited_by, upstream_license, score FROM ("
        "  SELECT *, fts_main_case_text.match_bm25(id, ?) AS score FROM case_text) "
        "WHERE score IS NOT NULL ORDER BY score DESC LIMIT 20",
        ["internal flight alternative"]).fetchall()
"""

import argparse, os, sys, json, urllib.request, urllib.error

BASE = "https://huggingface.co/datasets/a2aj/{repo}/resolve/main/{cfg}/train.parquet"
API = "https://huggingface.co/api/datasets/a2aj/{repo}/tree/main?recursive=true"

# Court/tribunal decisions and legislation worth having for an Ontario
# civil + Federal Court immigration practice. Edit freely.
PROFILE = {
    "canadian-case-law": ["RAD", "RPD", "RLLR", "FC", "FCA", "SCC", "ONCA"],
    "canadian-laws": ["LEGISLATION-FED", "REGULATIONS-FED",
                      "LEGISLATION-ON", "REGULATIONS-ON"],
}

# Upstream terms differ by source. IRB material came to A2AJ unrestricted;
# court material carries non-commercial and other limits. Check the
# upstream_license column before putting any of this behind a paywall.
UNRESTRICTED = {"RAD", "RPD", "RLLR"}


def remote_sizes(repo):
    with urllib.request.urlopen(API.format(repo=repo), timeout=60) as r:
        tree = json.load(r)
    out = {}
    for f in tree:
        if f.get("type") != "file" or not f["path"].endswith(".parquet"):
            continue
        parts = f["path"].split("/")
        if len(parts) < 2:                 # parquet at the repo root, no config
            continue
        out[parts[0]] = (f.get("lfs") or {}).get("size") or f.get("size", 0)
    return out


def fetch(url, path, expect):
    have = os.path.getsize(path) if os.path.exists(path) else 0
    if expect and have == expect:
        print(f"  {os.path.basename(path):22} {have/1e6:7.1f} MB  already complete")
        return
    if expect and have > expect:           # upstream changed; start over
        os.remove(path); have = 0
    req = urllib.request.Request(url)
    if have:
        req.add_header("Range", f"bytes={have}-")
    label = os.path.basename(path)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            # A server that ignores Range answers 200 with the whole file;
            # appending that to a partial file would corrupt it.
            resumed = have and r.status == 206
            done = have if resumed else 0
            with open(path, "ab" if resumed else "wb") as fh:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk); done += len(chunk)
                    if expect:
                        pct = 100 * done / expect
                        sys.stdout.write(f"\r  {label:22} {done/1e6:7.1f} / {expect/1e6:.1f} MB  {pct:5.1f}%")
                        sys.stdout.flush()
    except urllib.error.HTTPError as e:
        if e.code == 416 and have:         # range past EOF: already have it all
            print(f"  {label:22} {have/1e6:7.1f} MB  already complete")
            return
        print(f"\n  FAILED {label}: HTTP {e.code}")
        return
    print(f"\r  {label:22} {os.path.getsize(path)/1e6:7.1f} MB  done" + " " * 12)


def have_parquet(d):
    return os.path.isdir(d) and any(f.endswith(".parquet") for f in os.listdir(d))


def build_index(dest):
    import duckdb
    case_dir, law_dir = os.path.join(dest, "cases"), os.path.join(dest, "laws")
    if not have_parquet(case_dir) and not have_parquet(law_dir):
        print("Nothing downloaded; skipping index.")
        return
    db = os.path.join(dest, "a2aj.duckdb")
    con = duckdb.connect(db)
    for view, d in (("cases", case_dir), ("laws", law_dir)):
        if not have_parquet(d):
            continue
        # DDL can't take bind parameters in DuckDB, so quote the glob by hand.
        glob = os.path.join(d, "*.parquet").replace("'", "''")
        con.execute(f"CREATE OR REPLACE VIEW {view} AS "
                    f"SELECT * FROM read_parquet('{glob}', union_by_name=true)")

    if not have_parquet(case_dir):
        print(f"\nLegislation only -> {db}")
        con.close()
        return

    con.execute("INSTALL fts; LOAD fts;")
    # Carry upstream_license into the index so the non-commercial court sets
    # stay distinguishable from the unrestricted IRB ones at query time. Older
    # parquet may not have the column, so fall back to NULL rather than failing.
    cols = {r[0] for r in con.execute("DESCRIBE cases").fetchall()}
    licence = ("upstream_license" if "upstream_license" in cols
               else "NULL AS upstream_license")
    # The FTS index needs a unique document key; citations repeat across
    # datasets and are sometimes null, so key on a synthetic id.
    con.execute(f"""CREATE OR REPLACE TABLE case_text AS
                    SELECT row_number() OVER () AS id,
                           citation_en AS citation, dataset, name_en AS style,
                           document_date_en AS decided, url_en AS src,
                           citing_cases_count AS cited_by, {licence},
                           unofficial_text_en AS txt
                    FROM cases WHERE unofficial_text_en IS NOT NULL""")
    con.execute("PRAGMA create_fts_index('case_text','id','txt', overwrite=1)")
    n = con.execute("SELECT count(*) FROM case_text").fetchone()[0]
    print(f"\nIndexed {n:,} decisions -> {db}")
    for ds, cnt in con.execute(
            "SELECT dataset, count(*) FROM cases GROUP BY 1 ORDER BY 2 DESC").fetchall():
        print(f"  {str(ds):22} {cnt:>9,}")
    con.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=os.path.expanduser("~/a2aj"))
    ap.add_argument("--sets", help="comma-separated dataset codes, e.g. RAD,RPD,ONCA")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--no-index", action="store_true")
    a = ap.parse_args()

    dest = os.path.expanduser(a.dest)
    asked = [s.strip() for s in a.sets.split(",") if s.strip()] if a.sets else []
    plan, total, found = {}, 0, set()
    for repo, folder in (("canadian-case-law", "cases"), ("canadian-laws", "laws")):
        sizes = remote_sizes(repo)
        if a.all:
            want = list(sizes)
        elif asked:
            want = [s for s in asked if s in sizes]
        else:
            want = [s for s in PROFILE[repo] if s in sizes]
        found |= set(want)
        plan[repo] = (folder, want, sizes)
        total += sum(sizes[s] for s in want)

    for s in asked:
        if s not in found:
            print(f"Unknown dataset code, skipping: {s}")

    print(f"Destination: {dest}")
    print(f"To download: {total/1e9:.2f} GB\n")

    for repo, (folder, want, sizes) in plan.items():
        if not want:
            continue
        out = os.path.join(dest, folder)
        os.makedirs(out, exist_ok=True)
        print(f"{repo}:")
        for cfg in want:
            flag = "" if cfg in UNRESTRICTED or folder == "laws" else "  [non-commercial upstream]"
            print(f"    {cfg}{flag}")
            fetch(BASE.format(repo=repo, cfg=cfg),
                  os.path.join(out, f"{cfg}.parquet"), sizes[cfg])
        print()

    if not a.no_index:
        build_index(dest)


if __name__ == "__main__":
    main()
