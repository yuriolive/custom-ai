"use client";

/**
 * The "Add funds" dialog (FR-CON-006).
 *
 * Preset buttons plus a custom amount, one validated value, one redirect to
 * Stripe-hosted Checkout. No card field exists here and none may be added: the
 * platform stays in PCI SAQ-A precisely because card data never reaches a page
 * it serves (FR-BIL-030).
 *
 * Validation comes from `lib/billing/amounts.ts`, the same module the route
 * handler uses, so the message a developer sees before submitting is the one
 * the server would have produced. The server still re-validates — this copy is
 * a courtesy, never the gate.
 *
 * `onPress`, never `onClick` (FR-UI-002).
 */

import { Alert, Button, Description, Input, Label, Modal, TextField } from "@heroui/react";
import { useState } from "react";

import {
  formatUsdFromMicro,
  MAX_TOPUP_MICRO_USD,
  MICRO_PER_USD,
  MIN_TOPUP_MICRO_USD,
  TOPUP_PRESETS_MICRO_USD,
  validateTopupAmount,
} from "@/lib/billing/amounts";

/** Preset micro-USD → the plain dollar string the shared validator parses. */
function presetToRaw(microUsd: number): string {
  return String(microUsd / MICRO_PER_USD);
}

export function TopUpDialog({
  isOpen,
  onClose,
}: Readonly<{
  isOpen: boolean;
  onClose: () => void;
}>) {
  const [amountRaw, setAmountRaw] = useState<string>(presetToRaw(TOPUP_PRESETS_MICRO_USD[1]));
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = validateTopupAmount(amountRaw);
  // Only surface a validation message once the field has content — an empty
  // field on open is not an error the developer made.
  const inlineError = amountRaw.trim() === "" || parsed.ok ? null : parsed.message;

  async function startCheckout() {
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/wallet/topup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: amountRaw }),
      });
      const body = (await response.json()) as {
        url?: string;
        error?: { message?: string };
      };
      if (!response.ok || !body.url) {
        setError(body.error?.message ?? "Could not start checkout. Try again.");
        setSubmitting(false);
        return;
      }
      // Full navigation, not a new tab: Checkout's return URLs bring the
      // developer back to this page, and a popup would be blocked as often as
      // not. `isSubmitting` stays true so the button cannot be pressed twice
      // during the redirect.
      window.location.assign(body.url);
    } catch {
      setError("Network error reaching the payment service. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Add funds</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-4">
                {/* Buttons, not Chips: HeroUI's Chip is a presentational span
                    with no press handling, and a preset is a control. */}
                <div className="flex flex-wrap gap-2">
                  {TOPUP_PRESETS_MICRO_USD.map((preset) => {
                    const raw = presetToRaw(preset);
                    const isSelected = amountRaw.trim() === raw;
                    return (
                      <Button
                        key={preset}
                        onPress={() => {
                          setAmountRaw(raw);
                          setError(null);
                        }}
                        size="sm"
                        variant={isSelected ? "primary" : "outline"}
                      >
                        {formatUsdFromMicro(preset)}
                      </Button>
                    );
                  })}
                </div>

                {/* A TextField, not a NumberField: the shared validator parses
                    dollars-and-cents itself and rejects a third decimal place
                    rather than rounding it. A locale-formatting number input
                    would round `19.999` to `20.00` and charge the difference. */}
                <TextField
                  isInvalid={inlineError !== null}
                  onChange={(value) => {
                    setAmountRaw(value);
                    setError(null);
                  }}
                  value={amountRaw}
                >
                  <Label>Amount (USD)</Label>
                  <Input className="tabular-nums" inputMode="decimal" placeholder="20.00" />
                  <Description>
                    {inlineError ??
                      `${formatUsdFromMicro(MIN_TOPUP_MICRO_USD)} minimum, ${formatUsdFromMicro(
                        MAX_TOPUP_MICRO_USD,
                      )} maximum per top-up.`}
                  </Description>
                </TextField>

                <p className="text-muted max-w-prose text-xs">
                  Payment is handled on Stripe&rsquo;s own checkout page — card details never reach
                  this site. Your balance updates when Stripe confirms the payment, which is usually
                  a second or two after you return.
                </p>

                {error ? (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>Could not start checkout</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={isSubmitting} onPress={onClose} variant="ghost">
                Cancel
              </Button>
              <Button
                isDisabled={!parsed.ok || isSubmitting}
                onPress={() => void startCheckout()}
                variant="primary"
              >
                {isSubmitting
                  ? "Opening Stripe…"
                  : `Continue${parsed.ok ? ` — ${formatUsdFromMicro(parsed.microUsd)}` : ""}`}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
