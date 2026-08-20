---
# ca-7lpg
title: 'trust: decide whether re-listing suspended weights is evasion'
status: todo
type: task
priority: low
created_at: 2026-08-20T05:06:56Z
updated_at: 2026-08-20T05:06:56Z
blocked_by:
    - ca-zim3
---

#31 closed the escape hatch on the suspended ROW: `custom_models_update_own` now freezes
`deleted_at` while `suspended_at` stands, so a creator cannot soft-delete a suspended
listing to free its slot in `custom_models_variant_uniq` and re-list the same weights
unsuspended. pgTAP 08 proves it, and proves the ordinary delete flow still works on an
unsuspended listing.

What is NOT closed: deploying the same (repo, revision, variant) as a brand-new listing
after a suspension. Today that is treated as a new listing and needs a new report and a
new takedown.

Whether that is a hole depends on a product decision nobody has made: is a takedown about
this listing, or about these weights from this creator? Blocking the second case needs a
suspension record that OUTLIVES the listing — a `suspended_variants` table keyed on
(user_id, hf_repo_slug, hf_revision, variant) that the insert policy consults — which is a
bigger table than #31 justified, and the wrong thing to half-build.

- [ ] decide the scope of a takedown: listing, or creator+variant
- [ ] if creator+variant: a record that survives the listing, consulted by
      `custom_models_insert_own`, with pgTAP for the re-list attempt
- [ ] either way, an operator-visible signal that a suspended variant was re-deployed
