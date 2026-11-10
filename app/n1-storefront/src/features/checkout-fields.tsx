"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Exit, Fiber } from "effect";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { FormInput } from "./form-controls";
import { Select } from "@techsio/ui-kit/molecules/select";
import type { Dictionary } from "@/i18n";
import {
  customerAddressesForIdentity,
  readCustomerAddresses,
} from "@/ontos/customer-addresses-client";
import type {
  CustomerAddressIdentity,
  CustomerAddressesSnapshot,
} from "@/ontos/customer-addresses-client";
import { clientRuntime } from "@/ontos/client-runtime";
import { usePortalAuth } from "./auth-view";
import { checkoutFieldAttributes, checkoutFieldError } from "./checkout-field-validation";
import {
  checkoutPostalForIdentity,
  checkoutSavedAddressItems,
  copyCheckoutSavedAddress,
  editCheckoutPostal,
  initialCheckoutPostalDraft,
} from "./checkout-saved-address";
import type { CheckoutPostalDraft } from "./checkout-saved-address";

type Field = keyof typeof checkoutFieldAttributes;
type FieldErrors = Partial<Record<Field, string | null>>;
interface CheckoutFieldState {
  readonly epoch: number;
  readonly errors: FieldErrors;
  readonly identity: CustomerAddressIdentity | null;
  readonly postal: CheckoutPostalDraft;
  readonly snapshot: (CustomerAddressesSnapshot & { readonly generation: number }) | null;
}

const clearPostalErrors = (errors: FieldErrors) => ({
  ...errors,
  city: null,
  postalCode: null,
  street: null,
});

const checkoutAddressIdentity = (
  auth: Pick<ReturnType<typeof usePortalAuth>, "loaded" | "outcome" | "pending">,
) => (auth.loaded && !auth.pending && auth.outcome.state === "admitted" ? auth.outcome : null);

const checkoutFieldStateForIdentity = (
  state: CheckoutFieldState,
  identity: CustomerAddressIdentity | null,
  countryCodes: readonly string[],
): CheckoutFieldState => {
  const identityChanged = state.identity !== identity;
  const postal = checkoutPostalForIdentity(state.postal, identity, countryCodes);
  if (!identityChanged && postal === state.postal) {
    return state;
  }
  return {
    epoch: state.epoch + (identityChanged ? 1 : 0),
    errors: postal === state.postal ? state.errors : clearPostalErrors(state.errors),
    identity,
    postal,
    snapshot: identityChanged ? null : state.snapshot,
  };
};

const countryNames = {
  cs: new Intl.DisplayNames(["cs"], { type: "region" }),
  en: new Intl.DisplayNames(["en"], { type: "region" }),
};
/** Native order fields with explicit, lossless reuse of the admitted customer's saved postal data. */
export const CheckoutFields = ({
  countryCodes,
  dictionary: d,
  disabled,
  locale,
  onEdit,
}: {
  countryCodes: readonly string[];
  dictionary: Dictionary;
  disabled: boolean;
  locale: string;
  onEdit: () => void;
}) => {
  const id = useId();
  const auth = usePortalAuth({ mode: "login" });
  const identity = checkoutAddressIdentity(auth);
  const [fieldState, setFieldState] = useState<CheckoutFieldState>(() => ({
    epoch: 0,
    errors: {},
    identity,
    postal: initialCheckoutPostalDraft(countryCodes),
    snapshot: null,
  }));
  const state = checkoutFieldStateForIdentity(fieldState, identity, countryCodes);
  if (state !== fieldState) {
    // Adjust only this component atomically; its parent independently observes Portal/country changes.
    setFieldState(state);
  }
  const { epoch, errors, postal: currentPostal, snapshot } = state;
  const postalValues: Partial<Record<Field, string>> = currentPostal.fields;
  const selectionContext = useRef({ countryCodes, disabled, epoch, identity, snapshot });
  useLayoutEffect(() => {
    selectionContext.current = { countryCodes, disabled, epoch, identity, snapshot };
  }, [countryCodes, disabled, epoch, identity, snapshot]);
  useEffect(() => {
    let current = true;
    const fiber = identity === null ? null : clientRuntime.runFork(readCustomerAddresses());
    if (fiber !== null && identity !== null) {
      fiber.addObserver((exit) => {
        if (current) {
          setFieldState((previous) => {
            if (previous.identity !== identity || previous.epoch !== epoch) {
              return previous;
            }
            return {
              ...previous,
              snapshot: {
                generation: epoch,
                identity,
                result: Exit.isSuccess(exit) ? exit.value : { state: "unavailable" },
              },
            };
          });
        }
      });
    }
    return () => {
      current = false;
      if (fiber !== null) {
        clientRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [epoch, identity]);
  const addressState =
    identity === null || snapshot?.generation !== epoch
      ? null
      : customerAddressesForIdentity(snapshot, identity);
  const addresses = addressState?.state === "ready" ? addressState.addresses : [];
  const savedItems = checkoutSavedAddressItems(
    addresses,
    countryCodes,
    snapshot?.generation ?? 0,
    d.checkout.savedAddresses,
  );
  const selected = savedItems.find(
    (item) => item.addressId === currentPostal.selectedAddressId && !item.disabled,
  );
  const countries = countryCodes.map((value) => ({
    label: countryNames[locale === "en" ? "en" : "cs"].of(value) ?? value,
    value,
  }));
  const input = (field: Field) => {
    const error = errors[field] ?? undefined;
    const errorId = `${id}-${field}-error`;
    // The dotted-domain constraint matches the existing public checkout contact schema.
    const pattern = field === "email" ? String.raw`[^\s@]+@[^\s@]+\.[^\s@]+` : String.raw`.*\S.*`;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <FormInput
          {...checkoutFieldAttributes[field]}
          aria-describedby={error === undefined ? undefined : errorId}
          disabled={disabled}
          id={`${id}-${field}`}
          label={d.checkout[field]}
          name={field}
          onBlur={(event) => {
            const message = checkoutFieldError(field, event.currentTarget.validity, d);
            setFieldState((previous) => ({
              ...previous,
              errors: { ...previous.errors, [field]: message },
            }));
          }}
          onChange={(event) => {
            const { value } = event.currentTarget;
            setFieldState((previous) => ({
              ...previous,
              errors: { ...previous.errors, [field]: null },
              postal:
                field === "city" || field === "postalCode" || field === "street"
                  ? editCheckoutPostal(previous.postal, identity, countryCodes, field, value)
                  : previous.postal,
            }));
            onEdit();
          }}
          onInvalid={(event) => {
            event.preventDefault();
            const message = checkoutFieldError(field, event.currentTarget.validity, d);
            setFieldState((previous) => ({
              ...previous,
              errors: { ...previous.errors, [field]: message },
            }));
          }}
          pattern={field === "phone" ? undefined : pattern}
          size="md"
          validateStatus={error === undefined ? "default" : "error"}
          value={postalValues[field]}
        />
        {error === undefined ? null : (
          <StatusText id={errorId} showIcon size="sm" status="error">
            {error}
          </StatusText>
        )}
      </div>
    );
  };
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
      <h2 className="text-lg font-semibold">{d.checkout.address}</h2>
      {savedItems.length > 0 && (
        <Select
          disabled={disabled}
          id={`${id}-saved-address`}
          items={savedItems}
          onValueChange={({ value }) => {
            const { current } = selectionContext;
            if (
              current.disabled ||
              current.epoch !== epoch ||
              current.identity !== identity ||
              current.snapshot !== snapshot ||
              current.countryCodes !== countryCodes
            ) {
              return;
            }
            const item = savedItems.find((option) => option.value === value[0]);
            if (item === undefined || item.disabled) {
              return;
            }
            const copied = copyCheckoutSavedAddress({
              addressId: item.addressId,
              countryCodes,
              disabled: current.disabled,
              identity,
              snapshot,
            });
            if (copied !== null) {
              setFieldState((previous) =>
                previous.identity === identity && previous.epoch === epoch
                  ? { ...previous, errors: clearPostalErrors(previous.errors), postal: copied }
                  : previous,
              );
              onEdit();
            }
          }}
          size="lg"
          value={selected === undefined ? [] : [selected.value]}
        >
          <Select.Label>{d.checkout.savedAddresses.label}</Select.Label>
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder={d.checkout.savedAddresses.placeholder} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {savedItems.map((item) => (
                <Select.Item item={item} key={item.value}>
                  <Select.ItemText />
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
          <Select.StatusText>{d.checkout.savedAddresses.shared}</Select.StatusText>
        </Select>
      )}
      {(addressState?.state === "unavailable" || addressState?.state === "forbidden") && (
        <StatusText showIcon status="error">
          {d.accountPage.addressUnavailable}
        </StatusText>
      )}
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <div className="min-w-0">{input("firstName")}</div>
        <div className="min-w-0">{input("lastName")}</div>
      </div>
      {input("street")}
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <div className="min-w-0">{input("city")}</div>
        <div className="min-w-0">
          <Select
            disabled={disabled}
            id={`${id}-country`}
            items={countries}
            name="country"
            onValueChange={({ value }) => {
              setFieldState((previous) => ({
                ...previous,
                postal: editCheckoutPostal(
                  previous.postal,
                  identity,
                  countryCodes,
                  "country",
                  value[0] ?? "",
                ),
              }));
              onEdit();
            }}
            required
            size="lg"
            value={
              countryCodes.includes(currentPostal.fields.country)
                ? [currentPostal.fields.country]
                : []
            }
          >
            <Select.Label>{d.checkout.country}</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText placeholder={d.checkout.countryPlaceholder} />
              </Select.Trigger>
            </Select.Control>
            <Select.Positioner>
              <Select.Content>
                {countries.map((item) => (
                  <Select.Item item={item} key={item.value}>
                    <Select.ItemText />
                    <Select.ItemIndicator />
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Positioner>
          </Select>
        </div>
      </div>
      {input("postalCode")}
      {input("phone")}
      {input("email")}
      {auth.loaded && !auth.pending && auth.outcome.state === "anonymous" && (
        <p className="text-sm text-fg-secondary">{d.checkout.guest}</p>
      )}
    </section>
  );
};
