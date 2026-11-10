"use client";
// UI-kit form controls that mark a required field with "*" and read a hidden text after it for screen readers.
// The kit's text is English; these give it the market language once, so forms import the controls from here.
import type { ComponentProps } from "react";
import { Combobox as KitCombobox, type ComboboxProps } from "@techsio/ui-kit/molecules/combobox";
import { FormInput as KitFormInput } from "@techsio/ui-kit/molecules/form-input";
import { FormTextarea as KitFormTextarea } from "@techsio/ui-kit/molecules/form-textarea";
import { PhoneInput } from "@techsio/ui-kit/molecules/phone-input";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import { useDictionary } from "@/ontos/market-context";

const useRequiredLabel = () => useDictionary().forms.requiredLabel;

export function FormInput(props: ComponentProps<typeof KitFormInput>) {
  return <KitFormInput requiredLabel={useRequiredLabel()} {...props} />;
}

export function FormTextarea(props: ComponentProps<typeof KitFormTextarea>) {
  return <KitFormTextarea requiredLabel={useRequiredLabel()} {...props} />;
}

export function Combobox<T = unknown>(props: ComboboxProps<T>) {
  return <KitCombobox requiredLabel={useRequiredLabel()} {...props} />;
}

/** `PhoneInput.Label` of a required `PhoneInput`. */
export function PhoneInputLabel(props: ComponentProps<typeof PhoneInput.Label>) {
  return <PhoneInput.Label requiredLabel={useRequiredLabel()} {...props} />;
}

/** `RadioGroup.Label` of a required `RadioGroup`. */
export function RadioGroupLabel(props: ComponentProps<typeof RadioGroup.Label>) {
  return <RadioGroup.Label requiredLabel={useRequiredLabel()} {...props} />;
}
