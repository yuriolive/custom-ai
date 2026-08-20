---
# ca-57jc
title: ssm_state_bytes drifts between the two catalogs (conv state and dtype)
status: todo
type: bug
priority: normal
created_at: 2026-08-20T03:49:14Z
updated_at: 2026-08-20T03:49:14Z
parent: ca-mun8
---

Found while fixing #37 (bean ca-ellh). The per-sequence SSM state is computed two ways:

- SQL, `public.calc_ssm_state_bytes()`:
  `n_ssm_layers * dtype * (conv_kernel * (inner + 2 * group * state) + inner * state)`
  = 81,084,416 bytes for the MVP target.
- Python, `ModelShape.ssm_state_bytes_per_sequence`:
  `2 * n_ssm_layers * inner * state`
  = 77,070,336 bytes for the same model.

The Python side omits the conv state entirely and folds the dtype into the leading `2`.
It under-counts by 4,014,080 bytes per stream (~4.9%), so the two catalogs disagree on
`bytes_per_stream` and therefore on the slot count they would emit for the same model —
the same class of drift #37 was about, one term over.

The SQL is the one that runs at request time and is the one to converge on. Doing it
properly needs two fields the Python `ModelShape` does not carry (`ssm_group_count`,
`ssm_conv_kernel`), threaded through `deploy.py`'s CLI and its `--dry-run` output, which
is why it was left out of the #37 fix rather than bolted on.

## Todo

- [ ] Add ssm_group_count / ssm_conv_kernel to ModelShape and deploy.py's arguments
- [ ] Mirror calc_ssm_state_bytes() exactly in ssm_state_bytes_per_sequence
- [ ] Assert the two formulas agree on the MVP geometry in test_tier_drift.py
