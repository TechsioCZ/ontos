"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { Effect, Exit, Fiber, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { CustomerProfileApi } from "@/ontos/customer-profile";
import { sameCheckoutCustomer } from "./checkout-session-observation";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { FormInput } from "./form-controls";
import { Select } from "@techsio/ui-kit/molecules/select";
import type { Dictionary } from "@/i18n";
import { countryName } from "@/i18n/country-name";
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
type FieldErrors = Partial<Record<Field | "country", string | null>>;
type ContactField = "firstName" | "lastName" | "email" | "phone";
const contactDefaults = (identity: CustomerAddressIdentity | null) => {
  const [firstName = "", ...lastName] = identity?.name.trim().split(/\s+/u) ?? [];
  return { email: identity?.email ?? "", firstName, lastName: lastName.join(" "), phone: "" };
};
const profileClient = HttpApiClient.make(CustomerProfileApi);
const readCheckoutProfile = profileClient.pipe(
  Effect.flatMap((api) => api.customerProfile.read()),
  Effect.timeout("65 seconds"),
);
interface CheckoutFieldState {
  readonly contact: Record<ContactField, string>;
  readonly epoch: number;
  readonly errors: FieldErrors;
  readonly identity: CustomerAddressIdentity | null;
  readonly postal: CheckoutPostalDraft;
  readonly prefillVersion: number;
  readonly snapshot: (CustomerAddressesSnapshot & { readonly generation: number }) | null;
  readonly touched: Partial<Record<ContactField, boolean>>;
}

const clearPostalErrors = (errors: FieldErrors) => ({
  ...errors,
  city: null,
  country: null,
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
  const customerChanged = !sameCheckoutCustomer(state.identity, identity);
  const postal = customerChanged
    ? initialCheckoutPostalDraft(countryCodes)
    : checkoutPostalForIdentity(state.postal, identity, countryCodes);
  if (!identityChanged && postal === state.postal) {
    return state;
  }
  return {
    contact: customerChanged ? contactDefaults(identity) : state.contact,
    epoch: state.epoch + (identityChanged ? 1 : 0),
    errors: postal === state.postal ? state.errors : clearPostalErrors(state.errors),
    identity,
    postal,
    prefillVersion: state.prefillVersion,
    snapshot: customerChanged ? null : state.snapshot,
    touched: customerChanged ? {} : state.touched,
  };
};

/** Keep the editable draft separate from refreshable, admission-scoped own reads. */
const useCheckoutFields = (
  countryCodes: readonly string[],
  disabled: boolean,
  onEdit: () => void,
) => {
  const auth = usePortalAuth({ mode: "login" });
  // Keep the draft through a pending read, while private reads/selections still require admission.
  const identity = auth.loaded && auth.outcome.state === "admitted" ? auth.outcome : null;
  const readIdentity = checkoutAddressIdentity(auth);
  const [fieldState, setFieldState] = useState<CheckoutFieldState>(() => ({
    contact: contactDefaults(identity),
    epoch: 0,
    errors: {},
    identity,
    postal: initialCheckoutPostalDraft(countryCodes),
    prefillVersion: 0,
    snapshot: null,
    touched: {},
  }));
  const state = checkoutFieldStateForIdentity(fieldState, identity, countryCodes);
  if (state !== fieldState) {
    // Adjust only this component atomically; its parent independently observes Portal/country changes.
    setFieldState(state);
  }
  const profileEdited = useEffectEvent(() => onEdit());
  const { prefillVersion } = state;
  useEffect(() => {
    if (prefillVersion > 0) {
      profileEdited();
    }
  }, [prefillVersion]);
  const { epoch, errors, postal: currentPostal, snapshot } = state;
  const values = { ...currentPostal.fields, ...state.contact } satisfies Record<Field, string>;
  const currentSnapshot = snapshot?.identity === identity && snapshot?.generation === epoch;
  const selectionDisabled = disabled || readIdentity === null || !currentSnapshot;
  const selectionContext = useRef({
    countryCodes,
    disabled: selectionDisabled,
    epoch,
    identity,
    snapshot,
  });
  useLayoutEffect(() => {
    selectionContext.current = {
      countryCodes,
      disabled: selectionDisabled,
      epoch,
      identity,
      snapshot,
    };
  }, [countryCodes, selectionDisabled, epoch, identity, snapshot]);
  useEffect(() => {
    let current = true;
    const fiber = readIdentity === null ? null : clientRuntime.runFork(readCustomerAddresses());
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
  }, [epoch, identity, readIdentity]);
  useEffect(() => {
    let current = true;
    const fiber = readIdentity === null ? null : clientRuntime.runFork(readCheckoutProfile);
    if (fiber !== null && readIdentity !== null) {
      fiber.addObserver((exit) => {
        if (!current || !Exit.isSuccess(exit) || exit.value.state !== "ready") {
          return;
        }
        const { profile } = exit.value;
        setFieldState((previous) => {
          if (previous.identity !== readIdentity || previous.epoch !== epoch) {
            return previous;
          }
          const defaults = {
            ...contactDefaults({ ...readIdentity, name: profile.displayName }),
            email: profile.contactEmail.trim() || readIdentity.email,
            phone: profile.phone,
          };
          const contact = { ...previous.contact };
          let changed = false;
          for (const field of ["firstName", "lastName", "email", "phone"] as const) {
            if (previous.touched[field] !== true && contact[field] !== defaults[field]) {
              contact[field] = defaults[field];
              changed = true;
            }
          }
          return changed
            ? { ...previous, contact, prefillVersion: previous.prefillVersion + 1 }
            : previous;
        });
      });
    }
    return () => {
      current = false;
      if (fiber !== null) {
        clientRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [epoch, readIdentity]);
  // Keep the last same-customer list visible during refresh. Selection still requires
  // a fresh exact-admission snapshot, enforced by selectionDisabled and the copy boundary.
  const addressState =
    snapshot === null || !sameCheckoutCustomer(snapshot.identity, identity)
      ? null
      : customerAddressesForIdentity(snapshot, snapshot.identity);
  return {
    addressState,
    auth,
    currentPostal,
    epoch,
    errors,
    identity,
    readIdentity,
    selectionContext,
    selectionDisabled,
    setFieldState,
    snapshot,
    values,
  };
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
  const {
    addressState,
    auth,
    currentPostal,
    epoch,
    errors,
    identity,
    readIdentity,
    selectionContext,
    selectionDisabled,
    setFieldState,
    snapshot,
    values,
  } = useCheckoutFields(countryCodes, disabled, onEdit);
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
    label: countryName(value, locale),
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
              contact:
                field === "firstName" ||
                field === "lastName" ||
                field === "email" ||
                field === "phone"
                  ? { ...previous.contact, [field]: value }
                  : previous.contact,
              errors: { ...previous.errors, [field]: null },
              postal:
                field === "city" || field === "postalCode" || field === "street"
                  ? editCheckoutPostal(previous.postal, identity, countryCodes, field, value)
                  : previous.postal,
              touched:
                field === "firstName" ||
                field === "lastName" ||
                field === "email" ||
                field === "phone"
                  ? { ...previous.touched, [field]: true }
                  : previous.touched,
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
          value={values[field]}
        />
        {error === undefined ? null : (
          <StatusText id={errorId} showIcon size="sm" status="error">
            {error}
          </StatusText>
        )}
      </div>
    );
  };
  const country = () => {
    const countryError = errors.country ?? undefined;
    return (
      <div
        className="min-w-0"
        onInvalidCapture={(event) => {
          if (Schema.is(Schema.instanceOf(HTMLSelectElement))(event.target)) {
            event.preventDefault();
            const message = checkoutFieldError("country", event.target.validity, d);
            setFieldState((previous) => ({
              ...previous,
              errors: { ...previous.errors, country: message ?? null },
            }));
          }
        }}
      >
        <Select
          disabled={disabled}
          id={`${id}-country`}
          items={countries}
          name="country"
          onValueChange={({ value }) => {
            setFieldState((previous) => ({
              ...previous,
              errors: { ...previous.errors, country: null },
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
          size="md"
          validateStatus={countryError === undefined ? "default" : "error"}
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
          {countryError !== undefined && (
            <Select.StatusText status="error">{countryError}</Select.StatusText>
          )}
        </Select>
      </div>
    );
  };
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xs border border-border-secondary bg-fill-surface p-4">
      <h2 className="text-lg font-semibold">{d.checkout.address}</h2>
      {savedItems.length > 0 && (
        <Select
          disabled={selectionDisabled}
          id={`${id}-saved-address`}
          items={savedItems}
          onValueChange={({ value }) => {
            const { current } = selectionContext;
            if (
              current.disabled ||
              readIdentity === null ||
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
          size="md"
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
        {country()}
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
