"use client";

/**
 * /console/keys — FR-CON-001..003.
 *
 * The split of responsibility here is the whole point, and it follows
 * CONTRACTS.md §Frontend / auth contract exactly:
 *
 *   CREATE  -> POST /api/keys. `api_keys` has no client INSERT policy, because
 *              the plaintext must be generated server-side and shown once.
 *   RENAME  -> straight from the browser. RLS allows UPDATE on own rows and its
 *              WITH CHECK pins `key_hash` and `key_prefix`, so the worst a
 *              malicious client can do here is rename its own key.
 *   REVOKE  -> also straight from the browser, same policy, behind a
 *              confirmation because it is immediate and irreversible.
 *
 * `key_hash` is never selected (see `KEY_COLUMNS` in lib/console/queries.ts) and
 * therefore never reaches this bundle.
 */

import { Button, Dropdown } from "@heroui/react";
import { Table } from "@heroui/react";
import { useCallback, useMemo, useState } from "react";

import { formatDate, formatRelative, formatTokens } from "@/lib/console/format";
import { fetchApiKeys } from "@/lib/console/queries";
import type { ApiKeyRow, CreatedApiKey } from "@/lib/console/types";
import { createClient } from "@/lib/supabase/client";

import { CreateKeyDialog, RenameKeyDialog, RevealKeyModal, RevokeKeyDialog } from "./key-dialogs";
import { EmptyPanel, ErrorPanel, KeyStatusChip, PanelHeader, TableSkeleton } from "./primitives";

/** Which mutation is in flight, so exactly one control shows a pending state. */
type Pending = "create" | "rename" | "revoke" | "reload" | null;

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unexpected error.";
}

export function KeysPanel({
  initialKeys,
  now,
}: {
  initialKeys: ApiKeyRow[];
  /**
   * The server's clock at render time. Passed as a prop rather than read from
   * `Date.now()` during render so the server HTML and the hydrated client agree
   * on every relative timestamp.
   */
  now: number;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [pending, setPending] = useState<Pending>(null);
  /** Errors that belong to the page, not to an open dialog. */
  const [pageError, setPageError] = useState<string | null>(null);
  /** Errors that belong to whichever dialog is open. */
  const [dialogError, setDialogError] = useState<string | null>(null);

  const [isCreateOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [renameTarget, setRenameTarget] = useState<ApiKeyRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const reload = useCallback(async () => {
    setPageError(null);
    try {
      setKeys(await fetchApiKeys(supabase));
    } catch (error) {
      setPageError(message(error));
    }
  }, [supabase]);

  // ── Create: the one operation that needs a server route ───────────────────
  const create = useCallback(
    async (name: string) => {
      setPending("create");
      setDialogError(null);
      try {
        const response = await fetch("/api/keys", {
          body: JSON.stringify({ name }),
          cache: "no-store",
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const detail =
            typeof body === "object" &&
            body !== null &&
            typeof (body as { error?: { message?: unknown } }).error?.message === "string"
              ? (body as { error: { message: string } }).error.message
              : `Request failed with status ${response.status}.`;
          setDialogError(detail);
          return;
        }

        // Hand the plaintext straight to the reveal modal's state and nowhere
        // else. It is not logged, not written to storage, and not kept once
        // that modal closes.
        setCreateOpen(false);
        setCreated(body as CreatedApiKey);
        await reload();
      } catch (error) {
        setDialogError(message(error));
      } finally {
        setPending(null);
      }
    },
    [reload],
  );

  // ── Rename: direct, under RLS ─────────────────────────────────────────────
  const rename = useCallback(
    async (name: string) => {
      if (!renameTarget) return;
      setPending("rename");
      setDialogError(null);
      const { error } = await supabase.from("api_keys").update({ name }).eq("id", renameTarget.id);
      setPending(null);

      if (error) {
        setDialogError(error.message);
        return;
      }
      setRenameTarget(null);
      await reload();
    },
    [reload, renameTarget, supabase],
  );

  // ── Revoke: direct, under RLS, soft delete ────────────────────────────────
  const revoke = useCallback(async () => {
    if (!revokeTarget) return;
    setPending("revoke");
    setDialogError(null);
    // `.is("revoked_at", null)` makes this idempotent: a double submit cannot
    // overwrite the original revocation timestamp with a later one.
    const { error } = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", revokeTarget.id)
      .is("revoked_at", null);
    setPending(null);

    if (error) {
      setDialogError(error.message);
      return;
    }
    setRevokeTarget(null);
    await reload();
  }, [reload, revokeTarget, supabase]);

  const isEmpty = keys.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        action={
          <Button onPress={() => setCreateOpen(true)} variant="primary">
            Create key
          </Button>
        }
        description="Keys authenticate your OpenAI-compatible clients against the gateway. Only a SHA-256 hash of each key is stored, so a key is shown in full exactly once — when you create it."
        title="API keys"
      />

      {pageError ? <ErrorPanel detail={pageError} onRetry={reload} /> : null}

      {pending === "reload" ? (
        <TableSkeleton columns={6} />
      ) : isEmpty ? (
        <EmptyPanel
          action={
            <Button onPress={() => setCreateOpen(true)} variant="primary">
              Create your first key
            </Button>
          }
          description="You have no API keys yet. Create one to start making requests — you will be shown the full key once, then only its prefix."
          title="No API keys"
        />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="Your API keys">
              <Table.Header>
                <Table.Column isRowHeader>Name</Table.Column>
                <Table.Column>Key</Table.Column>
                <Table.Column className="hidden sm:table-cell">Created</Table.Column>
                <Table.Column className="hidden md:table-cell">Last used</Table.Column>
                <Table.Column className="hidden md:table-cell">Requests</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column>
                  {/* Actions column — the header is decorative, so it is
                      announced by its accessible name only. */}
                  <span className="sr-only">Actions</span>
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {keys.map((key) => (
                  <Table.Row id={key.id} key={key.id}>
                    <Table.Cell className="font-medium">{key.name}</Table.Cell>
                    <Table.Cell>
                      {/* Display prefix only. The remaining 35 characters of the
                          key exist nowhere on the server. */}
                      <code className="text-muted font-mono text-xs whitespace-nowrap">
                        {key.key_prefix}…
                      </code>
                    </Table.Cell>
                    <Table.Cell className="hidden tabular-nums sm:table-cell">
                      {formatDate(key.created_at)}
                    </Table.Cell>
                    <Table.Cell className="text-muted hidden md:table-cell">
                      {formatRelative(key.last_used_at, now)}
                    </Table.Cell>
                    <Table.Cell className="hidden text-end tabular-nums md:table-cell">
                      {formatTokens(key.request_count)}
                    </Table.Cell>
                    <Table.Cell>
                      <KeyStatusChip revokedAt={key.revoked_at} />
                    </Table.Cell>
                    <Table.Cell>
                      <KeyActions
                        isRevoked={key.revoked_at !== null}
                        onRename={() => {
                          setDialogError(null);
                          setRenameTarget(key);
                        }}
                        onRevoke={() => {
                          setDialogError(null);
                          setRevokeTarget(key);
                        }}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      {/* These two columns are counted at the point a request is admitted for
          billing, which is not the same as "every call you made with this key".
          Saying so is cheaper than the support thread that follows a developer
          watching their requests 401 while "Requests" stays put — see the
          `request_count` column comment in
          supabase/migrations/20260819000400_api_key_usage_counters.sql. */}
      {isEmpty ? null : (
        <p className="text-muted max-w-prose text-xs">
          <span className="font-medium">Last used</span> and{" "}
          <span className="font-medium">Requests</span> count requests admitted for billing. A call
          turned away at the gate — revoked key, empty wallet, model not ready — is not counted and
          does not move <span className="font-medium">Last used</span>.
        </p>
      )}

      <CreateKeyDialog
        error={dialogError}
        isOpen={isCreateOpen}
        isPending={pending === "create"}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setDialogError(null);
        }}
        onSubmit={create}
      />

      <RevealKeyModal
        created={created}
        // Dropping the state is what makes "shown exactly once" true on the
        // client side as well: after this, no component holds the plaintext and
        // no request can fetch it again.
        onClose={() => setCreated(null)}
      />

      <RenameKeyDialog
        error={dialogError}
        isPending={pending === "rename"}
        onClose={() => {
          setRenameTarget(null);
          setDialogError(null);
        }}
        onSubmit={rename}
        target={renameTarget}
      />

      <RevokeKeyDialog
        error={dialogError}
        isPending={pending === "revoke"}
        onClose={() => {
          setRevokeTarget(null);
          setDialogError(null);
        }}
        onConfirm={revoke}
        target={revokeTarget}
      />
    </div>
  );
}

/** Per-row actions Dropdown (FR-CON-001). */
function KeyActions({
  isRevoked,
  onRename,
  onRevoke,
}: {
  isRevoked: boolean;
  onRename: () => void;
  onRevoke: () => void;
}) {
  return (
    <Dropdown>
      <Dropdown.Trigger>
        <Button isIconOnly size="sm" variant="ghost">
          {/* Named for assistive tech; the glyph alone says nothing. */}
          <span aria-hidden="true">⋯</span>
          <span className="sr-only">Key actions</span>
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu>
          <Dropdown.Item onAction={onRename}>Rename</Dropdown.Item>
          <Dropdown.Item
            // A revoked key cannot be revoked again — the option is disabled
            // rather than hidden so the row's shape stays stable.
            isDisabled={isRevoked}
            onAction={onRevoke}
          >
            Revoke
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
