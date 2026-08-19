"""
Offline drift check: tiers.py vs the state the migrations leave in the database.

    cd tools/modal && python -m unittest test_tier_drift -v

There are two GPU catalogs in this repo and only one of them runs at request time:
`public.gpu_tiers`, which public.resolve_placement() iterates cheapest-first and turns
into cost_floor_micro_per_mtoken. tiers.py is what the Python tooling solves against.
They diverged once — the SQL side carried RunPod hardware and RunPod prices, up to 2.3x
under Modal's real rate — and nothing failed, because nothing compared them. This does.

WHY PARSE THE MIGRATIONS instead of querying a real Postgres: CI already runs the
migrations against a real database in the `pgtap` job, but that job costs ~10 minutes and
needs Docker, while the `python` job installs nothing at all (pyproject has zero
dependencies) and finishes in seconds. A price mismatch is a data question, not a
Postgres-semantics question, so it does not need a server — and putting it in the cheap
job means it fails first, before the expensive one starts. `modal billing rates` is the
other direction (are the committed prices still Modal's?) and needs a credential, so it
lives in sync_rates.py and never runs in CI.

The SQL reader below is deliberately NARROW: it models only the statement shapes these
migrations actually use, and raises on anything else that touches either table. A future
migration written in a shape it does not understand fails loudly here rather than being
silently skipped — which would turn this test green while the catalogs drift again.
"""

from __future__ import annotations

import re
import unittest
from decimal import Decimal
from pathlib import Path

from tiers import GPU_TIERS, SOLVER_CONFIG

MIGRATIONS = Path(__file__).resolve().parent.parent.parent / "supabase" / "migrations"

TRACKED_TABLES = ("gpu_tiers", "solver_config")


class UnsupportedSql(RuntimeError):
    """A statement touching a tracked table that this reader cannot model."""


def _strip_comments(sql: str) -> str:
    out = []
    for line in sql.splitlines():
        # No tracked statement uses a `--` inside a string literal, so a plain cut is safe.
        out.append(line.split("--", 1)[0])
    return "\n".join(out)


def _strip_function_bodies(sql: str) -> str:
    """
    Drop every dollar-quoted block. Function bodies (resolve_placement and friends) READ
    these tables but never change the rows, so they carry no state this check compares —
    and their `;`-separated interiors would otherwise be split as if they were top-level
    statements. Leaves a marker so a body can never be mistaken for a real statement.
    """
    return re.sub(r"\$\$.*?\$\$", " '<function body>' ", sql, flags=re.DOTALL)


def _split_statements(sql: str) -> list[str]:
    statements, current, in_string = [], [], False
    for ch in sql:
        if ch == "'":
            in_string = not in_string
        if ch == ";" and not in_string:
            statements.append("".join(current))
            current = []
        else:
            current.append(ch)
    if "".join(current).strip():
        statements.append("".join(current))
    return [s.strip() for s in statements if s.strip()]


def _split_top_level(text: str) -> list[str]:
    """Split on commas that are not inside parentheses or a string literal."""
    parts, current, depth, in_string = [], [], 0, False
    for ch in text:
        if ch == "'":
            in_string = not in_string
        if not in_string:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append("".join(current).strip())
                current = []
                continue
        current.append(ch)
    if "".join(current).strip():
        parts.append("".join(current).strip())
    return parts


def _literal(token: str):
    token = token.strip()
    if token.startswith("'") and token.endswith("'"):
        return token[1:-1].replace("''", "'")
    low = token.lower()
    if low in ("true", "false"):
        return low == "true"
    if low == "null":
        return None
    if re.fullmatch(r"-?\d+", token):
        return int(token)
    if re.fullmatch(r"-?\d+\.\d+", token):
        return Decimal(token)  # solver_config.value is numeric; never a float here
    raise UnsupportedSql(f"cannot evaluate literal {token!r}")


class Catalog:
    """The rows the migrations leave behind, replayed in filename order."""

    def __init__(self) -> None:
        self.gpu_tiers: dict[str, dict] = {}
        self.solver_config: dict[str, Decimal] = {}
        self.renames: dict[str, str] = {}

    # ── statement handlers ──────────────────────────────────────────────────
    def _insert(self, stmt: str) -> None:
        m = re.match(
            r"insert\s+into\s+public\.(\w+)\s*\((?P<cols>[^)]*)\)\s*values\s*(?P<rest>.*)",
            stmt,
            re.IGNORECASE | re.DOTALL,
        )
        if not m:
            raise UnsupportedSql(stmt[:120])
        table = m.group(1)
        cols = [c.strip() for c in m.group("cols").split(",")]
        rest = m.group("rest")

        conflict = ""
        cm = re.search(r"on\s+conflict\b(?P<clause>.*)$", rest, re.IGNORECASE | re.DOTALL)
        if cm:
            conflict = cm.group("clause")
            rest = rest[: cm.start()]

        rows = [
            _split_top_level(r) for r in re.findall(r"\(((?:[^()']|'[^']*')*)\)", rest, re.DOTALL)
        ]
        for raw in rows:
            values = dict(zip(cols, [_literal(v) for v in raw], strict=True))
            if table == "gpu_tiers":
                self._upsert_tier(values, conflict)
            elif table == "solver_config":
                self.solver_config[values["key"]] = values["value"]
            else:
                raise UnsupportedSql(f"insert into an untracked table: {table}")

    def _upsert_tier(self, values: dict, conflict: str) -> None:
        tier_id = values["id"]
        existing = self.gpu_tiers.get(tier_id)
        if existing is None:
            self.gpu_tiers[tier_id] = values
            return
        if "do nothing" in conflict.lower():
            return
        if "do update" not in conflict.lower():
            raise UnsupportedSql(f"duplicate insert for tier {tier_id!r} with no conflict clause")
        for assignment in _split_top_level(conflict.split("set", 1)[1]):
            col, _, expr = (p.strip() for p in assignment.partition("="))
            if expr.lower().startswith("excluded."):
                source = expr.split(".", 1)[1].strip()
                if source not in values:
                    raise UnsupportedSql(f"excluded.{source} is not in the insert column list")
                existing[col] = values[source]
            else:
                existing[col] = _literal(expr)

    def _update(self, stmt: str) -> None:
        m = re.match(
            r"update\s+public\.(?P<table>\w+)\s+set\s+(?P<sets>.*?)"
            r"\s+where\s+id\s*(?P<op>in|=)\s*(?P<ids>.*)$",
            stmt,
            re.IGNORECASE | re.DOTALL,
        )
        if not m or m.group("table") != "gpu_tiers":
            raise UnsupportedSql(stmt[:120])
        ids = [_literal(t) for t in re.findall(r"'[^']*'", m.group("ids"))]
        if not ids:
            raise UnsupportedSql("update with no literal id list")
        for assignment in _split_top_level(m.group("sets")):
            col, _, expr = (p.strip() for p in assignment.partition("="))
            for tier_id in ids:
                if tier_id in self.gpu_tiers:
                    self.gpu_tiers[tier_id][col] = _literal(expr)

    def _rename(self, stmt: str) -> None:
        m = re.search(r"rename\s+column\s+(?P<old>\w+)\s+to\s+(?P<new>\w+)", stmt, re.IGNORECASE)
        if not m:
            raise UnsupportedSql(stmt[:120])
        old, new = m.group("old"), m.group("new")
        self.renames[old] = new
        for row in self.gpu_tiers.values():
            if old in row:
                row[new] = row.pop(old)

    # ── driver ──────────────────────────────────────────────────────────────
    def replay(self) -> Catalog:
        for path in sorted(MIGRATIONS.glob("*.sql")):
            for stmt in _split_statements(
                _strip_function_bodies(_strip_comments(path.read_text(encoding="utf-8")))
            ):
                if not any(t in stmt for t in TRACKED_TABLES):
                    continue
                head = stmt.lower().lstrip()
                try:
                    if head.startswith("insert into public.gpu_tiers") or head.startswith(
                        "insert into public.solver_config"
                    ):
                        self._insert(stmt)
                    elif head.startswith("update public.gpu_tiers"):
                        self._update(stmt)
                    elif "rename column" in head and "gpu_tiers" in head:
                        self._rename(stmt)
                    elif head.startswith(
                        ("create table", "alter table", "create policy", "comment on", "grant")
                    ):
                        continue  # DDL and grants: no effect on the data being compared
                    else:
                        raise UnsupportedSql(stmt[:160])
                except UnsupportedSql as exc:
                    raise UnsupportedSql(
                        f"{path.name}: this drift check does not understand a statement that "
                        f"touches gpu_tiers/solver_config, so it cannot verify the catalog. "
                        f"Teach the reader this shape rather than removing the statement.\n"
                        f"  {exc}"
                    ) from exc
        return self

    @property
    def enabled_tiers(self) -> dict[str, dict]:
        return {k: v for k, v in self.gpu_tiers.items() if v.get("is_enabled", True)}


class TierCatalogDriftTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = Catalog().replay()
        cls.py_tiers = {t.id: t for t in GPU_TIERS if t.is_enabled}

    def test_migrations_were_actually_read(self):
        self.assertTrue(self.catalog.gpu_tiers, f"no gpu_tiers rows parsed from {MIGRATIONS}")

    def test_enabled_tier_ids_match(self):
        self.assertEqual(
            sorted(self.catalog.enabled_tiers),
            sorted(self.py_tiers),
            "gpu_tiers and tiers.py disagree on which tiers exist. An id enabled only in "
            "SQL can be resolved at request time and then fail to provision; an id only in "
            "tiers.py is hardware production will never select.",
        )

    def test_hardware_and_price_match(self):
        for tier_id, py in sorted(self.py_tiers.items()):
            row = self.catalog.enabled_tiers.get(tier_id)
            if row is None:
                continue  # reported by test_enabled_tier_ids_match
            with self.subTest(tier=tier_id):
                self.assertEqual(row["vram_bytes"], py.vram_bytes, "vram_bytes")
                self.assertEqual(
                    row["memory_bandwidth_bytes_s"],
                    py.memory_bandwidth_bytes_s,
                    "memory_bandwidth_bytes_s — this sets predicted tok/s on both paths",
                )
                self.assertEqual(
                    row["usd_per_hour_micro"],
                    py.usd_per_hour_micro,
                    "usd_per_hour_micro — the SQL value is what the live cost floor uses, "
                    "so an under-priced row sells GPU time below cost",
                )
                self.assertEqual(row["sort_order"], py.sort_order, "sort_order")
                self.assertEqual(row["label"], py.label, "label")

    def test_provider_gpu_id_is_the_modal_literal(self):
        # The column was `runpod_gpu_ids` and held RunPod ids. After the rename it must
        # carry exactly the string `@app.cls(gpu=...)` accepts, or provisioning resolves
        # to hardware Modal cannot give us (e.g. "A10G", which Modal rejects; it is "A10").
        self.assertEqual(self.catalog.renames.get("runpod_gpu_ids"), "provider_gpu_id")
        for tier_id, py in sorted(self.py_tiers.items()):
            row = self.catalog.enabled_tiers.get(tier_id)
            if row is not None:
                with self.subTest(tier=tier_id):
                    self.assertEqual(row["provider_gpu_id"], py.modal_gpu_string)

    def test_shared_solver_constants_match(self):
        # Set equality is NOT required: prefix_cache_reserve, volume_threshold_bytes and
        # download_bytes_per_s exist only on the SQL path, which does cold-start and
        # prefix-cache budgeting that the Python solver does not model. Only the keys both
        # sides carry have to agree — those feed the same arithmetic in two places.
        shared = sorted(set(SOLVER_CONFIG) & set(self.catalog.solver_config))
        self.assertEqual(
            shared,
            sorted(SOLVER_CONFIG),
            "a constant in SOLVER_CONFIG has no row in solver_config; the SQL solver would "
            "read NULL for it",
        )
        for key in shared:
            with self.subTest(key=key):
                self.assertEqual(
                    self.catalog.solver_config[key],
                    Decimal(str(SOLVER_CONFIG[key])),
                    f"solver constant {key!r} differs between the two catalogs",
                )

    def test_retired_tiers_are_disabled_not_deleted(self):
        # custom_models.gpu_tier_id is an FK onto this table and
        # gpu_usd_per_hour_micro_snapshot keeps historical cost math reproducible
        # (FR-DEP-051). Deleting a retired tier breaks that audit trail; disabling it
        # keeps the solver away from it, which is all that was needed.
        for retired in ("rtx4090", "h100_80"):
            with self.subTest(tier=retired):
                self.assertIn(retired, self.catalog.gpu_tiers, "row was deleted, not disabled")
                self.assertFalse(self.catalog.gpu_tiers[retired]["is_enabled"])


if __name__ == "__main__":
    unittest.main()
