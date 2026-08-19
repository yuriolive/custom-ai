"use client";

/**
 * The two dialogs of the My Models table: edit pricing, and delete.
 *
 * Both are controlled from `my-models-table.tsx` — `isOpen` / `onOpenChange`
 * rather than a trigger, because both are launched from a row's actions
 * Dropdown and a menu item cannot also be a dialog trigger.
 *
 * `onPress`, never `onClick` (FR-UI-002).
 */

import {
  Alert,
  AlertDialog,
  Button,
  Description,
  Input,
  Label,
  Modal,
  NumberField,
  TextField,
} from "@heroui/react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { SnippetTabs } from "@/components/marketplace/snippet-tabs";

import {
  formatPricePerMtoken,
  microToDollarsPerMtoken,
  microUsdEcho,
  PRICE_FORMAT_OPTIONS,
} from "@/lib/studio/format";
import type { MyModelRow } from "@/lib/studio/types";

// ─── Edit pricing (FR-STU-009, FR-STU-013) ──────────────────────────────────

export function EditPricingDialog({
  error,
  isPending,
  onClose,
  onSubmit,
  target,
}: Readonly<{
  error: string | null;
  isPending: boolean;
  onClose: () => void;
  /** Micro-USD per 1M tokens, integers. */
  onSubmit: (promptMicro: number, completionMicro: number) => void;
  target: MyModelRow | null;
}>) {
  const [prompt, setPrompt] = useState(0);
  const [completion, setCompletion] = useState(0);

  useEffect(() => {
    if (!target) return;
    setPrompt(microToDollarsPerMtoken(target.pricePromptMicro));
    setCompletion(microToDollarsPerMtoken(target.priceCompletionMicro));
  }, [target]);

  if (!target) return null;

  // The single float-to-integer step, mirrored from the deploy form. Rounding
  // the SCALED value, not truncating it: 1.23 * 1e6 is 1229999.9999999998 in
  // IEEE-754 and would persist as a one-micro-dollar understatement.
  const promptMicro = Math.round(prompt * 1_000_000);
  const completionMicro = Math.round(completion * 1_000_000);
  const floor = target.costFloorMicroPerMtoken;
  const belowFloor = floor !== null && (promptMicro < floor || completionMicro < floor);
  const valid =
    Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Pricing for {target.displayName}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-4">
                {/* Same `formatOptions` as the deploy form, for the same
                    reason: without it a comma-decimal locale silently reads
                    "3.25" as 325 and reprices the model 100x. */}
                <NumberField
                  formatOptions={PRICE_FORMAT_OPTIONS}
                  minValue={0}
                  onChange={setPrompt}
                  step={0.01}
                  value={prompt}
                >
                  <Label>Prompt price · per 1M tokens</Label>
                  <Input className="tabular-nums" />
                  <Description className="tabular-nums">{microUsdEcho(promptMicro)}</Description>
                </NumberField>

                <NumberField
                  formatOptions={PRICE_FORMAT_OPTIONS}
                  minValue={0}
                  onChange={setCompletion}
                  step={0.01}
                  value={completion}
                >
                  <Label>Completion price · per 1M tokens</Label>
                  <Input className="tabular-nums" />
                  <Description className="tabular-nums">
                    {microUsdEcho(completionMicro)}
                  </Description>
                </NumberField>

                {floor !== null ? (
                  <p className="text-muted text-xs">
                    Cost floor for this deployment:{" "}
                    <span className="tabular-nums">{formatPricePerMtoken(floor)}</span> per 1M
                    tokens.
                  </p>
                ) : null}

                {belowFloor ? (
                  <Alert status="warning">
                    <Alert.Content>
                      <Alert.Title>Below the cost floor</Alert.Title>
                      <Alert.Description>
                        You would be subsidising each request. This is allowed.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}

                {/* FR-STU-013: a price change never re-bills work already in
                    flight. The transaction row snapshots the price at request
                    start, so this is a statement of fact, not reassurance. */}
                <p className="text-muted text-xs">
                  Requests already in flight bill at the price captured when they started.
                </p>

                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Could not save the new pricing</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={isPending} onPress={onClose} variant="ghost">
                Cancel
              </Button>
              <Button
                isDisabled={!valid || isPending}
                onPress={() => onSubmit(promptMicro, completionMicro)}
                variant="primary"
              >
                {isPending ? "Saving…" : "Save pricing"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Delete (FR-STU-010) ────────────────────────────────────────────────────

/**
 * Behind an `AlertDialog` requiring the slug to be typed.
 *
 * `role="alertdialog"` is what tells a screen reader this is a consequential
 * confirmation. Typing the slug is a guard against a mis-click on a row in a
 * list of similar rows — it is not a security control, and the route re-checks
 * ownership server-side regardless of what is typed here.
 *
 * The copy says what actually happens, because "delete" is imprecise: usage
 * history survives (a caller's ledger must stay readable), the stored token is
 * destroyed, and the model stops answering immediately.
 */
export function DeleteModelDialog({
  error,
  isPending,
  onClose,
  onConfirm,
  target,
}: Readonly<{
  error: string | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
  target: MyModelRow | null;
}>) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    setTyped("");
  }, [target]);

  if (!target) return null;

  const matches = typed.trim() === target.slug;

  return (
    <AlertDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialog.Backdrop>
        <AlertDialog.Container size="md">
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>Delete this model?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="flex flex-col gap-4">
                <p className="text-sm">
                  <span className="font-medium">{target.displayName}</span> stops answering requests
                  immediately and is removed from the catalog. Any stored Hugging Face token is
                  destroyed.
                </p>
                <p className="text-muted text-sm">
                  Billing history is kept — callers who paid for requests against this model must
                  still be able to read their own ledger.
                </p>

                <TextField autoFocus onChange={setTyped} value={typed}>
                  <Label>
                    Type <span className="font-mono">{target.slug}</span> to confirm
                  </Label>
                  <Input className="font-mono" placeholder={target.slug} />
                  <Description>This cannot be undone.</Description>
                </TextField>

                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Could not delete the model</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={isPending} onPress={onClose} variant="ghost">
                Cancel
              </Button>
              <Button isDisabled={!matches || isPending} onPress={onConfirm} variant="danger">
                {isPending ? "Deleting…" : "Delete model"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

// ─── Use this model (FR-MKT-008, reused for the creator's own models) ────────

/**
 * How a creator actually calls their own model.
 *
 * The same `SnippetTabs` the public model card uses, so there is exactly one
 * implementation of the three strings that decide whether a first call runs:
 * the platform model id (`handle/slug`, never the HF repo path), the gateway
 * base URL derived from this deployment, and the cold-start timeout.
 *
 * The key link is in the dialog rather than the snippet: the snippet's
 * `sk-plat-…` placeholder is the one value it cannot fill in, so the page that
 * mints it has to be one click away.
 */
export function UseModelDialog({
  baseUrl,
  modelId,
  onClose,
  target,
}: Readonly<{
  baseUrl: string;
  /** `creator-handle/model-slug`. Null when the handle could not be read. */
  modelId: string | null;
  onClose: () => void;
  target: MyModelRow | null;
}>) {
  if (!target) return null;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Call {target.displayName}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-4">
                {target.status === "ready" ? null : (
                  <Alert status="warning">
                    <Alert.Content>
                      <Alert.Title>Not serving yet</Alert.Title>
                      <Alert.Description>
                        This model answers requests once its status is Ready.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}

                {modelId ? (
                  <SnippetTabs baseUrl={baseUrl} modelId={modelId} />
                ) : (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>No creator handle</Alert.Title>
                      <Alert.Description>
                        The model id is <code>handle/{target.slug}</code>, and this account has no
                        handle set yet.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}

                <p className="text-muted text-sm">
                  The snippets need a key.{" "}
                  <Link className="text-accent font-medium hover:underline" href="/console/keys">
                    Create an API key →
                  </Link>
                </p>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button onPress={onClose} variant="ghost">
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
