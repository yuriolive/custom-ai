"use client";

/**
 * "My Models" — FR-STU-009, FR-STU-010, FR-STU-013.
 *
 * The split of responsibility follows CONTRACTS.md §Frontend / auth contract,
 * and the boundary is drawn by what RLS can actually express:
 *
 *   EDIT PRICING      -> straight from the browser. `custom_models_update_own`
 *                        permits it and its WITH CHECK pins slug, hf_repo_slug,
 *                        gpu_tier_id, upstream_endpoint_ref, hf_token_secret_id,
 *                        total_requests and platform_fee_bps — so the worst a
 *                        malicious client can do here is misprice its own model.
 *   TOGGLE VISIBILITY -> same policy, same reasoning.
 *   DELETE            -> a server route. There is NO client DELETE policy: the
 *                        Vault secret has to be destroyed and the row soft-
 *                        deleted so usage_transactions is never orphaned.
 *
 * The per-row `⋮` Dropdown belongs here and nowhere else (docs/DESIGN.md §3.3,
 * §4 item 10) — numerous, partly destructive actions on rows the user owns.
 *
 * NO GPU NAME APPEARS IN THIS TABLE. Hardware is confined to the Deployment
 * Plan on the deploy form (§4 item 8). What a creator manages here is a
 * capability and a price.
 */

import { Alert, Button, Dropdown, Table } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { formatMicroUsd, formatTokens } from "@/lib/format";
import { formatContext, formatPricePerMtoken } from "@/lib/studio/format";
import { fetchMyModels } from "@/lib/studio/queries";
import type { MyModelRow } from "@/lib/studio/types";
import { createClient } from "@/lib/supabase/client";

import { DeleteModelDialog, EditPricingDialog } from "./model-dialogs";
import { ModelStatusChip, StudioHeader } from "./primitives";

type Pending = "pricing" | "visibility" | "delete" | "reload" | null;

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

export function MyModelsTable({
  initialModels,
  userId,
}: Readonly<{
  initialModels: MyModelRow[];
  userId: string;
}>) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [models, setModels] = useState<MyModelRow[]>(initialModels);
  const [pending, setPending] = useState<Pending>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const [pricingTarget, setPricingTarget] = useState<MyModelRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MyModelRow | null>(null);

  const reload = useCallback(async () => {
    setPageError(null);
    try {
      setModels(await fetchMyModels(supabase, userId));
    } catch (error) {
      setPageError(message(error));
    }
  }, [supabase, userId]);

  // ── Pricing: direct, under RLS ───────────────────────────────────────────
  const savePricing = useCallback(
    async (promptMicro: number, completionMicro: number) => {
      if (!pricingTarget) return;
      setPending("pricing");
      setDialogError(null);

      const { data, error } = await supabase
        .from("custom_models")
        .update({
          price_prompt_micro_usd_per_mtoken: promptMicro,
          price_completion_micro_usd_per_mtoken: completionMicro,
          // FR-STU-013: pricing edits are versioned. In-flight requests bill at
          // the price snapshotted on their own transaction row, so bumping this
          // records the change without touching anything already reserved.
          pricing_version: pricingTarget.pricingVersion + 1,
        })
        .eq("id", pricingTarget.id)
        // Optimistic concurrency: if the row was repriced in another tab since
        // this dialog opened, this matches nothing and the edit is refused
        // rather than silently overwriting the newer price.
        .eq("pricing_version", pricingTarget.pricingVersion)
        .select("id");

      setPending(null);
      if (error) {
        setDialogError(error.message);
        return;
      }
      if (!data || data.length === 0) {
        setDialogError(
          "This model was repriced somewhere else while this dialog was open. Close it and try again to avoid overwriting the newer price.",
        );
        await reload();
        return;
      }
      setPricingTarget(null);
      await reload();
    },
    [pricingTarget, reload, supabase],
  );

  // ── Visibility: direct, under RLS ────────────────────────────────────────
  const toggleVisibility = useCallback(
    async (model: MyModelRow) => {
      setPending("visibility");
      setPageError(null);

      const { error } = await supabase
        .from("custom_models")
        .update({ visibility: model.visibility === "public" ? "private" : "public" })
        .eq("id", model.id);

      setPending(null);
      if (error) {
        setPageError(error.message);
        return;
      }
      await reload();
    },
    [reload, supabase],
  );

  // ── Delete: the one operation that needs a server route ──────────────────
  const remove = useCallback(async () => {
    if (!deleteTarget) return;
    setPending("delete");
    setDialogError(null);

    try {
      const response = await fetch(`/api/studio/models/${deleteTarget.id}`, {
        cache: "no-store",
        method: "DELETE",
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const detail =
          typeof body === "object" &&
          body !== null &&
          typeof (body as { message?: unknown }).message === "string"
            ? (body as { message: string }).message
            : `Request failed with status ${response.status}.`;
        setDialogError(detail);
        return;
      }
      setDeleteTarget(null);
      await reload();
    } catch (error) {
      setDialogError(message(error));
    } finally {
      setPending(null);
    }
  }, [deleteTarget, reload]);

  return (
    <div className="flex flex-col gap-6">
      <StudioHeader
        action={
          <Button onPress={() => router.push("/studio/new")} variant="primary">
            Deploy a model
          </Button>
        }
        description="Models you have published. Pricing and visibility take effect immediately; requests already in flight bill at the price they started with."
        title="My models"
      />

      {pageError ? (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>Something went wrong</Alert.Title>
            <Alert.Description>{pageError}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {models.length === 0 ? (
        <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="text-base font-medium">No models yet</p>
          <p className="text-muted max-w-md text-sm">
            Point Studio at a Hugging Face repository and it will work out what hardware serves it,
            how fast, and what it costs to run — before you deploy anything.
          </p>
          <div className="pt-1">
            <Link className="text-accent text-sm font-medium hover:underline" href="/studio/new">
              Deploy your first model →
            </Link>
          </div>
        </div>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Your models">
              <Table.Header>
                <Table.Column isRowHeader>Model</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column className="hidden text-end sm:table-cell">Speed</Table.Column>
                <Table.Column className="hidden text-end md:table-cell">Context</Table.Column>
                <Table.Column className="hidden text-end lg:table-cell">Requests</Table.Column>
                <Table.Column className="hidden text-end lg:table-cell">Tokens 30d</Table.Column>
                <Table.Column className="text-end">Earned 30d</Table.Column>
                <Table.Column>
                  <span className="sr-only">Actions</span>
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {models.map((model) => (
                  <Table.Row id={model.id} key={model.id}>
                    <Table.Cell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{model.displayName}</span>
                        <span className="text-muted font-mono text-xs">
                          {model.slug}
                          {model.visibility === "private" ? " · private" : ""}
                        </span>
                        {/* FR-STU-008: a failed model carries its remediation
                            hint on the row, not behind a click. */}
                        {model.remediationHint ? (
                          <span className="text-muted max-w-md text-xs">
                            {model.remediationHint}
                          </span>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <ModelStatusChip status={model.status} />
                    </Table.Cell>
                    {/* MEASURED, never predicted (FR-DEP-053). A model that has
                        not been measured shows a dash, not its prediction. */}
                    <Table.Cell className="hidden text-end tabular-nums sm:table-cell">
                      {model.measuredTokensPerSecond === null
                        ? "—"
                        : `${model.measuredTokensPerSecond} tok/s`}
                    </Table.Cell>
                    <Table.Cell className="hidden text-end tabular-nums md:table-cell">
                      {formatContext(model.contextLength)}
                    </Table.Cell>
                    <Table.Cell className="hidden text-end tabular-nums lg:table-cell">
                      {formatTokens(model.totalRequests)}
                    </Table.Cell>
                    <Table.Cell className="hidden text-end tabular-nums lg:table-cell">
                      {formatTokens(model.tokens30d)}
                    </Table.Cell>
                    <Table.Cell className="text-end tabular-nums">
                      {formatMicroUsd(model.earnings30dMicro)}
                    </Table.Cell>
                    <Table.Cell>
                      <RowActions
                        isBusy={pending !== null}
                        model={model}
                        onDelete={() => {
                          setDialogError(null);
                          setDeleteTarget(model);
                        }}
                        onEditPricing={() => {
                          setDialogError(null);
                          setPricingTarget(model);
                        }}
                        onToggleVisibility={() => void toggleVisibility(model)}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <p className="text-muted text-xs">
        Prices are per 1,000,000 tokens.{" "}
        {models.length > 0
          ? `Currently ${models
              .filter((m) => m.status === "ready")
              .map((m) => `${m.slug} at ${formatPricePerMtoken(m.priceCompletionMicro)}`)
              .join(", ")}.`
          : ""}
      </p>

      <EditPricingDialog
        error={dialogError}
        isPending={pending === "pricing"}
        onClose={() => setPricingTarget(null)}
        onSubmit={(p, c) => void savePricing(p, c)}
        target={pricingTarget}
      />

      <DeleteModelDialog
        error={dialogError}
        isPending={pending === "delete"}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void remove()}
        target={deleteTarget}
      />
    </div>
  );
}

function RowActions({
  isBusy,
  model,
  onDelete,
  onEditPricing,
  onToggleVisibility,
}: Readonly<{
  isBusy: boolean;
  model: MyModelRow;
  onDelete: () => void;
  onEditPricing: () => void;
  onToggleVisibility: () => void;
}>) {
  return (
    <Dropdown>
      {/* `Dropdown.Trigger` IS the button, and it is React Aria's PRIMITIVE
          Button — not HeroUI's. Two consequences, both verified against
          @heroui/react 3.2.4 in the rendered DOM rather than inferred:

            1. Nesting a <Button> inside it, which the PRD's §4.1.0 anatomy
               table shows (`Dropdown.Trigger › Button`), emits
               `<button><button>` — invalid HTML and a nested interactive
               control that hit-testing and assistive tech both handle badly.
            2. It accepts no `variant`, `size` or `isIconOnly`; those are
               HeroUI Button props and are type errors here. Styling is
               className only. */}
      <Dropdown.Trigger
        aria-label={`Actions for ${model.displayName}`}
        className="text-muted hover:bg-surface-secondary hover:text-foreground focus-visible:ring-accent inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
        isDisabled={isBusy}
      >
        <svg aria-hidden="true" className="size-4" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu
          onAction={(key) => {
            if (key === "pricing") onEditPricing();
            else if (key === "visibility") onToggleVisibility();
            else if (key === "delete") onDelete();
          }}
        >
          <Dropdown.Item id="pricing">Edit pricing</Dropdown.Item>
          <Dropdown.Item id="visibility">
            {model.visibility === "public" ? "Make private" : "Make public"}
          </Dropdown.Item>
          <Dropdown.Item id="delete">Delete</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
