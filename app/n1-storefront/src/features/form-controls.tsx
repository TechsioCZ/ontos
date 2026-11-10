"use client";

import {
  FormInput as KitFormInput,
  FormInputRaw as KitFormInputRaw,
} from "@techsio/ui-kit/molecules/form-input";
import { FormTextarea as KitFormTextarea } from "@techsio/ui-kit/molecules/form-textarea";
import { RadioCard } from "@techsio/ui-kit/molecules/radio-card";
import { createContext, useContext } from "react";
import type { ComponentProps, ReactNode } from "react";

/**
 * UI-kit form controls mark a required field with "*" and read a hidden text after it for screen readers. The kit's
 * text is English. The locale layout gives the dictionary's text once and forms import their controls from here, so
 * every required field of the storefront reads it in the page language. Outside the layout the kit's text stays.
 */
const RequiredLabelContext = createContext<string | undefined>(undefined);

export const RequiredLabelProvider = ({
  children,
  requiredLabel,
}: {
  children: ReactNode;
  requiredLabel: string;
}) => <RequiredLabelContext value={requiredLabel}>{children}</RequiredLabelContext>;

const useRequiredLabel = () => {
  const requiredLabel = useContext(RequiredLabelContext);
  return requiredLabel === undefined ? {} : { requiredLabel };
};

export const FormInput = (props: ComponentProps<typeof KitFormInput>) => (
  <KitFormInput {...useRequiredLabel()} {...props} />
);

export const FormInputRaw = (props: ComponentProps<typeof KitFormInputRaw>) => (
  <KitFormInputRaw {...useRequiredLabel()} {...props} />
);

export const FormTextarea = (props: ComponentProps<typeof KitFormTextarea>) => (
  <KitFormTextarea {...useRequiredLabel()} {...props} />
);

/** `RadioCard.Label` of a required `RadioCard`. */
export const RadioCardLabel = (props: ComponentProps<typeof RadioCard.Label>) => (
  <RadioCard.Label {...useRequiredLabel()} {...props} />
);
