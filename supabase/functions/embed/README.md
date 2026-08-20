# `embed` — the gte-small embedder

Two directions, one model. Layer B of marketplace discovery (#28).

```
POST /functions/v1/embed  {"query": "a model for writing tests"}
  → {"model":"gte-small","dimension":384,"embedding":[ … 384 floats … ]}

POST /functions/v1/embed  {"base_model_ids":["<uuid>", …]}   Authorization: Bearer <service-role key>
  → {"model":"gte-small","dimension":384,"embedded":2}
```

## Why both paths live in one function

The query and the document must be embedded **by the same model**, or the cosine distance
between them is a number about nothing. Two functions is two places for the model name to drift,
and the drift produces no error anywhere — just a semantic arm that quietly retrieves the wrong
models.

## Why there is no API key here

`Supabase.ai.Session('gte-small')` runs the model **inside** the edge runtime: no network call,
no external provider, no credential. That is the whole reason #28 adds nothing to
`docs/CONTRACTS.md` §Environment. It is also why `base_models.embedding` is `vector(384)` — 384
is gte-small's output width, stated once in `dimension.ts` and once in
`public.embedding_dimension()`, with `components/marketplace/hybrid-search.test.ts` pinning the
two to each other.

`verify_jwt = false` in `supabase/config.toml`, and the two paths are gated separately:

| path             | gate                                    | why                                                                                                                                                                        |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`          | none                                    | reads nothing, writes nothing, returns 384 floats about the caller's own text. Gating it behind the anon key would gate it behind a value published in the browser bundle. |
| `base_model_ids` | service-role key, constant-time compare | `base_models` has **no** client write policy at all. A creator who could write an embedding could put their listing next to any query in the arm.                          |

## Embedding at deploy time, never per listing

One document per **base model**. Six quantizations of the same weights embedded six times cost
six times as much and put six near-duplicate vectors in the top-k, where they crowd out every
other model — the result is a search that answers "Qwen3 8B" six times and shows nothing else.

The document (`document.ts`) carries the model's name, its weights publisher, its size, its
**use cases** and its summary. It carries nothing about price, speed, quantization or hardware:
those belong to a listing, they change without the weights changing, and any of them in the
document would mean a creator editing a price silently invalidates the vector.

The use-case sentence is the join between the two layers. A shopper who types `write unit tests`
shares no lexeme with `Qwen3 Coder 8B`, but `Used for code` sits in the same neighbourhood as
their query — so Layer A's closed vocabulary is what gives Layer B something to be near.

## Backfilling

The write path is idempotent, so re-embedding is safe. To embed everything that has no vector
yet:

```bash
# ids of unembedded base models
curl -s "$SUPABASE_URL/rest/v1/base_models?select=id&embedding=is.null" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# embed them, at most 50 per call
curl -s -X POST "$SUPABASE_URL/functions/v1/embed" \
  -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"base_model_ids":["…"]}'
```

A base model whose `embedding` is still NULL is skipped by the semantic arm rather than being
ranked as "distance unknown" — it is reachable lexically, and it is not a nearest neighbour of
everything. So an unembedded catalog degrades to exactly the prefix-FTS search that existed
before this function.
