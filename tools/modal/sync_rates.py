"""
sync_rates.py — reconcile the committed GPU prices against Modal's published rates.

LOCAL ONLY. It shells out to `modal billing rates --json`, which needs a Modal API
token, and CI holds none by design (see .github/workflows/ci.yml: the build/test jobs
must never reference a secret). The offline half of this job — "do the two committed
catalogs still agree with each other" — is test_tier_drift.py, and that is what runs
in CI.

    python sync_rates.py --check     # compare only; non-zero exit if anything drifted
    python sync_rates.py             # rewrite tiers.py + emit a migration to review

Money stays integer micro-USD end to end (CONTRACTS.md): the published rate arrives as a
decimal STRING and is converted with `decimal.Decimal`, never through float. A rate finer
than a micro-dollar is refused rather than rounded, because silently dropping a digit from
a price is the exact failure this script exists to catch.

Nothing here writes, logs, or reads a credential. The token lives in ~/.modal.toml or the
MODAL_TOKEN_* environment variables and is handled entirely by the `modal` CLI.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from tiers import GPU_TIERS

HERE = Path(__file__).resolve().parent
TIERS_PY = HERE / "tiers.py"
REPO_ROOT = HERE.parent.parent
MIGRATIONS = REPO_ROOT / "supabase" / "migrations"

MICRO = Decimal(1_000_000)

# This script only ever writes two things, and both are named here rather than assembled
# from anything that arrived at runtime. `modal billing rates` output reaches this process
# as prices — it must never reach it as a filename, and a generated migration must not be
# able to land outside supabase/migrations.
_ALLOWED_WRITE_DIRS = (HERE, MIGRATIONS)
_SAFE_NAME = re.compile(r"\A[A-Za-z0-9_]+\.(py|sql)\Z")


def _write_checked(name: str, directory: Path, text: str) -> Path:
    """
    Write `text` to `directory/name`, refusing anything that is not a plain filename in
    one of the two directories this script owns.
    """
    if directory not in _ALLOWED_WRITE_DIRS:
        raise SyncError(f"refusing to write outside this script's own directories: {directory}")
    if not _SAFE_NAME.fullmatch(name):
        raise SyncError(f"refusing to write a path-shaped filename: {name!r}")
    path = directory / name
    path.write_text(text, encoding="utf-8")
    return path


# `modal billing rates --json` key -> our tier id. Modal's own suffixes are the authority
# for the naming (`gpu_hour_cost_a100_80gb`), so this map is the one place where their
# spelling and ours are allowed to differ.
MODAL_KEY_TO_TIER_ID = {
    "gpu_hour_cost_t4": "t4",
    "gpu_hour_cost_l4": "l4",
    "gpu_hour_cost_a10g": "a10g",
    "gpu_hour_cost_l40s": "l40s",
    "gpu_hour_cost_a100_40gb": "a100_40",
    "gpu_hour_cost_a100_80gb": "a100_80",
    "gpu_hour_cost_h100": "h100",
    "gpu_hour_cost_h200": "h200",
    "gpu_hour_cost_b200": "b200",
}

LOCAL_ONLY = (
    "sync_rates.py is local-only: it needs a Modal API token, and CI deliberately has "
    "none. Run `modal token new` (or set MODAL_TOKEN_ID/MODAL_TOKEN_SECRET) on a "
    "workstation. The CI-side check is offline and credential-free: "
    "`cd tools/modal && python -m unittest test_tier_drift`."
)


class SyncError(RuntimeError):
    pass


def fetch_published_rates() -> dict[str, Decimal]:
    """{tier_id: hourly USD as Decimal} from the live Modal account."""
    if shutil.which("modal") is None:
        raise SyncError(f"`modal` is not on PATH. {LOCAL_ONLY}")

    proc = subprocess.run(
        ["modal", "billing", "rates", "--json"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        # An unauthenticated CLI is a plain non-zero exit with a message on stderr; there
        # is no distinct exit code to branch on, so the local-only hint goes out either way.
        raise SyncError(
            f"`modal billing rates --json` exited {proc.returncode}: "
            f"{proc.stderr.strip() or '(no stderr)'}\n{LOCAL_ONLY}"
        )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SyncError(f"`modal billing rates --json` did not return JSON: {exc}") from exc

    rates: dict[str, Decimal] = {}
    for key, tier_id in MODAL_KEY_TO_TIER_ID.items():
        if key not in payload:
            raise SyncError(
                f"Modal no longer publishes {key!r}. Either the GPU was retired (drop the "
                "tier) or the key was renamed (fix MODAL_KEY_TO_TIER_ID) — do not guess."
            )
        rates[tier_id] = Decimal(str(payload[key]))

    unmapped = sorted(
        k for k in payload if k.startswith("gpu_hour_cost_") and k not in MODAL_KEY_TO_TIER_ID
    )
    if unmapped:
        print(f"note: Modal offers GPUs this catalog does not carry: {', '.join(unmapped)}")
    return rates


def to_micro_per_hour(usd_per_hour: Decimal) -> int:
    """Exact micro-USD. Refuses anything finer than a micro-dollar rather than rounding."""
    micro = usd_per_hour * MICRO
    if micro != micro.to_integral_value():
        raise SyncError(
            f"published rate ${usd_per_hour} is finer than one micro-USD per hour; "
            "refusing to round a price silently"
        )
    return int(micro)


def to_micro_per_second(micro_per_hour: int) -> int:
    """
    The per-second field is DERIVED from the hourly rate, never published separately.
    Integer round-half-up, so no float ever touches a price.
    """
    return (micro_per_hour * 2 + 3600) // 7200


def diff(rates: dict[str, Decimal]) -> list[tuple[str, int, int, int, int]]:
    """(tier_id, committed_hour, published_hour, committed_second, published_second)."""
    out = []
    for tier in GPU_TIERS:
        if tier.id not in rates:
            raise SyncError(f"tier {tier.id!r} has no entry in MODAL_KEY_TO_TIER_ID")
        pub_hour = to_micro_per_hour(rates[tier.id])
        pub_second = to_micro_per_second(pub_hour)
        if pub_hour != tier.usd_per_hour_micro or pub_second != tier.usd_per_second_micro:
            out.append(
                (tier.id, tier.usd_per_hour_micro, pub_hour, tier.usd_per_second_micro, pub_second)
            )
    return out


def render_table(rows: list[tuple[str, int, int, int, int]]) -> str:
    lines = [
        f"{'tier':<10} {'committed $/h':>14} {'published $/h':>14} {'delta':>11}",
        "-" * 53,
    ]
    for tier_id, old, new, _, _ in rows:
        lines.append(
            f"{tier_id:<10} {old / 1_000_000:>14.6f} {new / 1_000_000:>14.6f} "
            f"{(new - old) / 1_000_000:>+11.6f}"
        )
    return "\n".join(lines)


def _u(n: int) -> str:
    """1950000 -> '1_950_000', matching the literal style already in tiers.py."""
    return f"{n:_d}"


def rewrite_tiers_py(rows: list[tuple[str, int, int, int, int]]) -> None:
    text = TIERS_PY.read_text(encoding="utf-8")
    for tier_id, _, new_hour, _, new_second in rows:
        # Anchored on the id line, rewriting only the two price lines that follow it. A
        # whole-file regex on `usd_per_hour_micro=` cannot tell one tier's price from
        # another's, and the failure mode is repricing the wrong GPU.
        pattern = re.compile(
            '(id="' + re.escape(tier_id) + '",.*?)'
            r"usd_per_hour_micro=[\d_]+,(\s*)usd_per_second_micro=[\d_]+,",
            re.DOTALL,
        )
        text, n = pattern.subn(
            lambda m, h=new_hour, s=new_second: f"{m.group(1)}usd_per_hour_micro={_u(h)},"
            f"{m.group(2)}usd_per_second_micro={_u(s)},",
            text,
            count=1,
        )
        if n != 1:
            raise SyncError(f"could not locate the price lines for tier {tier_id!r} in tiers.py")
    _write_checked(TIERS_PY.name, HERE, text)


MIGRATION_HEADER = """-- ============================================================================
-- {name}
--
-- Generated by tools/modal/sync_rates.py from `modal billing rates --json`.
-- REVIEW BEFORE COMMITTING: a price rise here raises cost_floor_micro_per_mtoken
-- for every placement resolved afterwards, so any model whose creator price sits
-- near the old floor is now selling GPU time under cost. Existing rows keep their
-- gpu_usd_per_hour_micro_snapshot (FR-DEP-051), so settled billing does not move
-- retroactively — only new placements do.
-- ============================================================================
"""


def emit_migration(rows: list[tuple[str, int, int, int, int]]) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    name = f"{stamp}_gpu_tier_rates.sql"
    updates = "\n".join(
        f"update public.gpu_tiers set usd_per_hour_micro = {new} "
        f"where id = '{tier_id}';  -- was {old}"
        for tier_id, old, new, _, _ in rows
    )
    return _write_checked(name, MIGRATIONS, MIGRATION_HEADER.format(name=name) + updates + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync GPU rates from Modal.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare only; exit non-zero on drift and write nothing",
    )
    args = parser.parse_args()

    try:
        rows = diff(fetch_published_rates())
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not rows:
        print(f"tiers.py matches Modal's published rates for all {len(GPU_TIERS)} tiers.")
        return 0

    print(render_table(rows))
    if args.check:
        print(f"\n{len(rows)} tier(s) drifted. Run `python sync_rates.py` to update.")
        return 1

    rewrite_tiers_py(rows)
    migration = emit_migration(rows)
    print(f"\nrewrote {TIERS_PY.name}")
    print(f"wrote   {migration.relative_to(REPO_ROOT)}")
    print("Review both, then commit. gpu_tiers is the catalog that runs at request time.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
