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

from tiers import (
    GIB,
    GPU_TIERS,
    MVP_TARGET_SHAPE,
    SLOT_HARD_CAP,
    SOLVER_CONFIG,
    ModelShape,
    evaluate_tier,
    slot_ceiling,
)

MIGRATIONS = Path(__file__).resolve().parent.parent.parent / "supabase" / "migrations"

TRACKED_TABLES = ("gpu_tiers", "solver_config")


class UnsupportedSql(RuntimeError):
    """A statement touching a tracked table that this reader cannot model."""


def _strip_comments(sql: str) -> str:
    """
    Cut `--` comments, but NOT ones inside a string literal.

    This was a plain `line.split("--", 1)[0]`, on the grounds that no tracked statement
    puts a `--` inside a literal. Then 20260820000100 described a config row as "the
    parallel flag" and the obvious way to write that is `--parallel`: the cut truncated
    the row mid-literal, the row-extraction regex saw unbalanced parens and skipped it,
    and the constant silently vanished from the comparison below. A drift check that can
    drop a row it does not understand is worse than one that raises.
    """
    out = []
    for line in sql.splitlines():
        in_string, cut = False, len(line)
        for i, ch in enumerate(line):
            if ch == "'":
                in_string = not in_string
            elif ch == "-" and not in_string and line.startswith("--", i):
                cut = i
                break
        out.append(line[:cut])
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

    def _delete(self, stmt: str) -> None:
        """
        `delete from public.solver_config where key = '...'` / `key in ('a','b')`.
        A retired constant has to LEAVE this dict, not linger: a solver_config row no
        function reads is a lie the next reader believes (20260820000100 retires
        `prefix_cache_reserve` for exactly that reason).
        """
        m = re.match(
            r"delete\s+from\s+public\.(?P<table>\w+)\s+where\s+key\s*(?:in|=)\s*(?P<keys>.*)$",
            stmt,
            re.IGNORECASE | re.DOTALL,
        )
        if not m or m.group("table") != "solver_config":
            raise UnsupportedSql(stmt[:120])
        keys = [_literal(t) for t in re.findall(r"'[^']*'", m.group("keys"))]
        if not keys:
            raise UnsupportedSql("delete with no literal key list")
        for key in keys:
            self.solver_config.pop(key, None)

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
                    elif head.startswith("delete from public.solver_config"):
                        self._delete(stmt)
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
        # Set equality is NOT required: volume_threshold_bytes and download_bytes_per_s
        # exist only on the SQL path, which does cold-start and weight-volume budgeting
        # that the Python solver does not model. Only the keys both sides carry have to
        # agree — those feed the same arithmetic in two places.
        #
        # `kv_headroom_reserve` USED TO BE one of the SQL-only keys, under the name
        # prefix_cache_reserve, and that was #37's fourth cause: the SQL solver divided
        # the KV pool by 0.85 and the Python solver did not divide at all, so the two
        # catalogs disagreed by ~17.6% on the number that becomes `--parallel`. An
        # SQL-only constant is only ever legitimate for arithmetic the other side does
        # not perform; it is never legitimate for a term in a shared formula.
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

    def test_retired_solver_constants_are_deleted_not_left_dangling(self):
        # The mirror image of the tier rule below: a TIER row must survive (inbound FKs,
        # reproducible historical cost math), a CONFIG row must not. resolve_placement no
        # longer reads `prefix_cache_reserve`, and llama.cpp has no prefix-cache pool for
        # it to describe, so a row left behind would only mislead.
        self.assertNotIn("prefix_cache_reserve", self.catalog.solver_config)
        self.assertIn("kv_headroom_reserve", self.catalog.solver_config)

    def test_slot_hard_cap_literal_matches(self):
        # The cap that survives a bad config row cannot itself live in config, so it is a
        # literal in two files and this is the only thing holding them together.
        sql = "\n".join(p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS.glob("*.sql")))
        found = re.findall(r"v_slot_hard_cap\s+constant\s+integer\s*:=\s*(\d+)", sql)
        self.assertEqual(
            len(found),
            1,
            "expected exactly one v_slot_hard_cap declaration across the migrations; "
            "two solvers with two hard caps is the drift this file exists to catch",
        )
        self.assertEqual(
            int(found[0]),
            SLOT_HARD_CAP,
            "the SQL solver's hard slot cap and tiers.py's SLOT_HARD_CAP disagree",
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


# ── #37: the aggregate allocation, mirrored ─────────────────────────────────────
#
# supabase/tests/07_placement_capacity_test.sql asserts the same invariant against the
# SQL solver, on a real Postgres, in the ~10-minute pgtap job. This is the same
# invariant against the Python solver in the job that costs nothing — and, because the
# two solvers are two implementations of one formula, an invariant that holds in only
# one of them is exactly the drift this file exists to catch.
#
# THE INVARIANT: no placement may emit a slot count whose AGGREGATE allocation exceeds
# usable VRAM. Not `weights + one stream + overhead <= usable`, which is what the
# solver checked when it handed the worker parallel=91: llama.cpp allocates
# ctx_size x parallel of KV eagerly at load, so the aggregate is the only figure that
# corresponds to anything the worker does.

# The #37 container, from its own log: the IQ2_M variant of the MVP repo at 9.90 GiB,
# 8192 context, and the hybrid geometry the probe reads for this architecture. This
# shape produced parallel=91 and a 745472-token total context; llama.cpp asked one card
# for 46592 MiB of KV (= 65536 bytes/token x 745472, the figure both catalogs compute
# for this geometry to the byte) and died.
INCIDENT_SHAPE = {
    "weights_bytes": 10_630_054_871,  # 9.90 GiB, per the container log
    "context_length": 8192,
    "n_layers": 65,
    "n_kv_heads": 4,
    "head_dim": 256,
    "full_attention_interval": 4,
    "ssm_state_size": 128,
    "ssm_inner_size": 6144,
    "target_tokens_per_second": 30,
}

CAPACITY_SHAPES = {
    "mvp_target": MVP_TARGET_SHAPE,
    "incident_iq2_m": INCIDENT_SHAPE,
    # Long context collapses the slot count toward 1 — the regime where the per-slot
    # compute term is largest relative to everything else.
    "mvp_target_262k": {**MVP_TARGET_SHAPE, "context_length": 262144},
    # Small dense model on a big card: the regime where the CAP binds and nothing else
    # does, which is the case the old solver got wrong.
    "small_dense": {
        "weights_bytes": 2 * GIB,
        "context_length": 4096,
        "n_layers": 32,
        "n_kv_heads": 8,
        "head_dim": 128,
        "target_tokens_per_second": 30,
    },
}


class AggregateCapacityTest(unittest.TestCase):
    def test_no_placement_exceeds_usable_vram(self):
        for name, kwargs in CAPACITY_SHAPES.items():
            for tier in GPU_TIERS:
                shape = ModelShape(**kwargs)
                ev = evaluate_tier(tier, shape)
                with self.subTest(shape=name, tier=tier.id):
                    if ev.max_concurrent_streams < 1:
                        self.assertFalse(ev.fits)
                        continue
                    self.assertLessEqual(
                        ev.aggregate_bytes,
                        ev.usable_vram_bytes,
                        f"{ev.max_concurrent_streams} slots x "
                        f"{ev.slot_cost_bytes / GIB:.2f} GiB plus "
                        f"{shape.weights_bytes / GIB:.2f} GiB of weights does not fit in "
                        f"{ev.usable_vram_bytes / GIB:.2f} GiB",
                    )

    def test_envelope_adds_up(self):
        # The identity a caller can check without knowing any solver constant:
        # weights + overhead(slots) + slots x per_stream == aggregate. Exact equality,
        # because `<=` would still hold if overhead silently reverted to a flat figure.
        for name, kwargs in CAPACITY_SHAPES.items():
            for tier in GPU_TIERS:
                ev = evaluate_tier(tier, ModelShape(**kwargs))
                with self.subTest(shape=name, tier=tier.id):
                    self.assertEqual(
                        ev.aggregate_bytes,
                        ModelShape(**kwargs).weights_bytes
                        + ev.overhead_bytes
                        + ev.max_concurrent_streams * ev.bytes_per_stream,
                    )

    def test_slot_count_is_capped_everywhere(self):
        self.assertLessEqual(slot_ceiling(), SLOT_HARD_CAP)
        for name, kwargs in CAPACITY_SHAPES.items():
            for tier in GPU_TIERS:
                ev = evaluate_tier(tier, ModelShape(**kwargs))
                with self.subTest(shape=name, tier=tier.id):
                    self.assertLessEqual(ev.max_concurrent_streams, slot_ceiling())

    def test_the_incident_slot_count_cannot_recur(self):
        # The a100_80 is the 80 GiB tier the arithmetic pins the incident to: reversing
        # 91 slots through the old formula lands on a card of exactly 85899345920 bytes.
        shape = ModelShape(**INCIDENT_SHAPE)
        ev = evaluate_tier(next(t for t in GPU_TIERS if t.id == "a100_80"), shape)
        self.assertTrue(ev.fits)
        self.assertLessEqual(ev.max_concurrent_streams, slot_ceiling())
        # The cap is what bound it, not the fit: without a ceiling this tier still
        # divides into dozens of slots. If this assertion ever fails the cap has stopped
        # being the operative constraint here, and the test above is no longer proving
        # what it claims to.
        self.assertGreater(ev.max_concurrent_streams_uncapped, slot_ceiling())
        # The two numbers the worker is actually handed, and what llama.cpp does with
        # them: total_ctx = ctx_size x parallel, and kv_bytes_per_token x total_ctx is
        # the buffer it allocates before serving a single token.
        total_ctx = shape.context_length * ev.max_concurrent_streams
        self.assertLess(total_ctx, 745472)
        self.assertLessEqual(
            shape.weights_bytes + ev.kv_bytes_per_token * total_ctx,
            ev.usable_vram_bytes,
            "the KV buffer llama.cpp allocates at load, plus the weights already on the "
            "card, must fit — this is the allocation that failed in #37",
        )

    def test_kv_per_token_still_matches_llama_cpp(self):
        # Ground truth from the #37 log: 46592 MiB / 745472 tokens = 65536 bytes/token.
        # This is the one number the solver already had right, and a "fix" that changes
        # it is a regression — it would be the declared key_length trap in reverse.
        self.assertEqual(ModelShape(**INCIDENT_SHAPE).kv_bytes_per_token, 65536)
        self.assertEqual(46592 * 1024 * 1024 // 745472, 65536)

    def test_more_slots_never_make_a_tier_look_cheaper(self):
        # #37's second cause: the cost floor divided by the slot count, so a tier that
        # could nominally hold more streams priced lower — the pricing math rewarded
        # inflating the value that becomes `--parallel`. Above batch_throughput_factor
        # the floor must be flat in the slot count.
        tier = next(t for t in GPU_TIERS if t.id == "a100_80")
        roomy = evaluate_tier(tier, ModelShape(**{**INCIDENT_SHAPE, "context_length": 2048}))
        tight = evaluate_tier(tier, ModelShape(**{**INCIDENT_SHAPE, "context_length": 8192}))
        self.assertGreaterEqual(
            roomy.max_concurrent_streams_uncapped, tight.max_concurrent_streams_uncapped
        )
        self.assertEqual(
            roomy.cost_floor_micro_per_mtoken,
            tight.cost_floor_micro_per_mtoken,
            "the cost floor still moves with the slot count",
        )


if __name__ == "__main__":
    unittest.main()
