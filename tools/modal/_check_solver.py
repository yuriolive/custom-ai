"""Scratch verification of the solver against the MVP target. Deleted before hand-off."""
from tiers import ModelShape, select_tier, MVP_TARGET_SHAPE, GIB

s = ModelShape(**MVP_TARGET_SHAPE)
print("attn layers   ", s.n_attention_layers, " ssm layers", s.n_ssm_layers)
print("kv/token      ", s.kv_bytes_per_token, "bytes =", s.kv_bytes_per_token / 1024, "KiB")
print("ssm state/seq ", s.ssm_state_bytes_per_sequence / 1024**2, "MiB")
print("per-stream    ", (s.kv_bytes_per_token * s.context_length + s.ssm_state_bytes_per_sequence) / GIB, "GiB")
print("weights       ", s.weights_bytes / GIB, "GiB")
print("overhead      ", s.overhead_bytes / GIB, "GiB")

p = select_tier(s)
print()
print("SELECTED", p.tier.id, p.tier.label, p.tier.modal_gpu_string)
print("  parallel", p.max_concurrent_streams, "predicted", p.predicted_tokens_per_second, "tok/s")
print("  cost floor", p.cost_floor_micro_per_mtoken, "micro-USD / 1M tok")
print()
for e in p.evaluations:
    print(
        f"  {e.tier_id:10s} fits={str(e.fits):5s} speed={str(e.meets_speed):5s} "
        f"par={e.max_concurrent_streams:3d} tps={e.predicted_tokens_per_second:5d} "
        f"${e.usd_per_hour_micro/1e6:.2f}/hr  {e.reject_reason or ''}"
    )
