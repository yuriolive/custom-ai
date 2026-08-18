"use client";

/**
 * The four dialogs of the keys page: create, reveal, rename, revoke.
 *
 * All four are controlled from `keys-panel.tsx` — `isOpen` / `onOpenChange`
 * rather than a `Modal.Trigger`, because rename and revoke are launched from a
 * row's actions Dropdown, and a menu item cannot also be a dialog trigger.
 *
 * `onPress`, never `onClick` (PRD FR-UI-002): HeroUI v3 is React Aria and an
 * `onClick` on one of these components is silently dropped.
 */

import {
  Alert,
  AlertDialog,
  Button,
  Checkbox,
  Description,
  Input,
  Label,
  Modal,
  TextField,
} from "@heroui/react";
import { useEffect, useId, useState } from "react";

import { KEY_NAME_MAX_LENGTH } from "@/lib/console/constants";
import type { ApiKeyRow, CreatedApiKey } from "@/lib/console/types";

import { CopyButton } from "./primitives";

// ─── Create ─────────────────────────────────────────────────────────────────

export function CreateKeyDialog({
  error,
  isOpen,
  isPending,
  onOpenChange,
  onSubmit,
}: {
  error: string | null;
  isOpen: boolean;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves when the mint request has settled; the parent owns the outcome. */
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");

  // Reset on open so a previous attempt's text does not reappear.
  useEffect(() => {
    if (isOpen) setName("");
  }, [isOpen]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !isPending;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Create an API key</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSubmit) onSubmit(trimmed);
                }}
              >
                <TextField
                  autoFocus
                  isRequired
                  maxLength={KEY_NAME_MAX_LENGTH}
                  onChange={setName}
                  value={name}
                >
                  <Label>Name</Label>
                  <Input placeholder="production backend" />
                  <Description>
                    For your own bookkeeping — up to {KEY_NAME_MAX_LENGTH} characters. It is not
                    part of the key.
                  </Description>
                </TextField>

                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Could not create the key</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}

                {/* Submit lives in the form so Enter works, and is mirrored in
                    the footer for pointer users. */}
                <button className="hidden" disabled={!canSubmit} type="submit">
                  Create
                </button>
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={isPending} onPress={() => onOpenChange(false)} variant="ghost">
                Cancel
              </Button>
              <Button isDisabled={!canSubmit} onPress={() => onSubmit(trimmed)} variant="primary">
                {isPending ? "Creating…" : "Create key"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Reveal ─────────────────────────────────────────────────────────────────

/**
 * FR-CON-002. The one and only render of a plaintext key.
 *
 * The value lives in the parent's state for as long as this modal is open and is
 * dropped the moment it closes — there is no second read path for it anywhere in
 * the product, because nothing persisted it. Two deliberate choices:
 *
 *  - `isDismissable={false}` on the backdrop. A stray click outside a normal
 *    modal costs nothing; here it would destroy the only copy of a credential.
 *    Escape is likewise disabled, and closing is an explicit acknowledgement.
 *  - `autoComplete="off"` + `readOnly` on the field, so no password manager or
 *    form-restore mechanism keeps its own copy.
 */
export function RevealKeyModal({
  created,
  onClose,
}: {
  created: CreatedApiKey | null;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (created) setAcknowledged(false);
  }, [created]);

  if (!created) return null;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop isDismissable={false} isKeyboardDismissDisabled>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>Copy your API key now</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-4">
                <Alert status="danger">
                  <Alert.Content>
                    <Alert.Title>This is the only time this key will be shown.</Alert.Title>
                    <Alert.Description>
                      Only a SHA-256 hash of it is stored, so nobody — including us — can show it to
                      you again. If you lose it, revoke this key and create another.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>

                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium" htmlFor={fieldId}>
                    {created.name}
                  </label>
                  {/* Deliberately a readonly text input rather than a HeroUI
                      `Input`: this is a value to select and copy, not a field to
                      edit. It borrows the field tokens so it still sits in the
                      same visual family as every real input. */}
                  <input
                    autoComplete="off"
                    className="border-field-border bg-field text-field-foreground rounded-field w-full border px-3 py-2 font-mono text-xs break-all select-all sm:text-sm"
                    id={fieldId}
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    spellCheck={false}
                    value={created.plaintext}
                  />
                  <CopyButton label="Copy key" value={created.plaintext} />
                </div>

                <Checkbox isSelected={acknowledged} onChange={setAcknowledged}>
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <span className="text-sm">
                      I have stored this key somewhere safe. I understand it cannot be retrieved
                      again.
                    </span>
                  </Checkbox.Content>
                </Checkbox>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={!acknowledged} onPress={onClose} variant="primary">
                Done
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Rename ─────────────────────────────────────────────────────────────────

export function RenameKeyDialog({
  error,
  isPending,
  onClose,
  onSubmit,
  target,
}: {
  error: string | null;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  target: ApiKeyRow | null;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (target) setName(target.name);
  }, [target]);

  if (!target) return null;

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== target.name && !isPending;

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
              <Modal.Heading>Rename key</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSubmit) onSubmit(trimmed);
                }}
              >
                <TextField
                  autoFocus
                  isRequired
                  maxLength={KEY_NAME_MAX_LENGTH}
                  onChange={setName}
                  value={name}
                >
                  <Label>Name</Label>
                  <Input />
                  <Description>
                    Renaming is cosmetic. The key itself does not change, and any client using it
                    keeps working.
                  </Description>
                </TextField>

                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Could not rename the key</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}

                <button className="hidden" disabled={!canSubmit} type="submit">
                  Save
                </button>
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={isPending} onPress={onClose} variant="ghost">
                Cancel
              </Button>
              <Button isDisabled={!canSubmit} onPress={() => onSubmit(trimmed)} variant="primary">
                {isPending ? "Saving…" : "Save"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

// ─── Revoke ─────────────────────────────────────────────────────────────────

/**
 * FR-CON-003. Behind an AlertDialog rather than a Modal: `role="alertdialog"`
 * is what tells a screen reader this is a consequential confirmation, and
 * revocation is immediate and irreversible — the gateway starts answering 401 to
 * that key on its next request.
 */
export function RevokeKeyDialog({
  error,
  isPending,
  onClose,
  onConfirm,
  target,
}: {
  error: string | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
  target: ApiKeyRow | null;
}) {
  if (!target) return null;

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
              <AlertDialog.Heading>Revoke this key?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  <span className="font-medium">{target.name}</span>{" "}
                  <code className="text-muted font-mono text-xs">{target.key_prefix}…</code>
                </p>
                <p className="text-muted text-sm">
                  Revocation takes effect immediately and cannot be undone. Any client still sending
                  this key will start getting{" "}
                  <code className="font-mono text-xs">401 invalid_api_key</code>. The row stays
                  visible here for your records.
                </p>
                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Could not revoke the key</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={isPending} onPress={onClose} variant="ghost">
                Keep it
              </Button>
              <Button isDisabled={isPending} onPress={onConfirm} variant="danger">
                {isPending ? "Revoking…" : "Revoke key"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}
