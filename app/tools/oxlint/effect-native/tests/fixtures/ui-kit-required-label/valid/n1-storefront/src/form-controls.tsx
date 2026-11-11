import { FormInput as KitInput, FormInputRaw as KitInputRaw } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea as KitTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { RadioCard } from '@techsio/ui-kit/molecules/radio-card';
import type { ComponentProps } from 'react';

/** Standalone storefront controls get this text from their own locale provider, not the administration. */
const useRequiredLabel = () => ({ requiredLabel: '(povinné)' });

export const FormInput = (props: ComponentProps<typeof KitInput>) => <KitInput {...useRequiredLabel()} {...props} />;
export const FormInputRaw = (props: ComponentProps<typeof KitInputRaw>) => (
  <KitInputRaw {...useRequiredLabel()} {...props} />
);
export const FormTextarea = (props: ComponentProps<typeof KitTextarea>) => (
  <KitTextarea {...useRequiredLabel()} {...props} />
);
export const RadioCardLabel = (props: ComponentProps<typeof RadioCard.Label>) => (
  <RadioCard.Label {...useRequiredLabel()} {...props} />
);
export const Shipping = () => (
  <RadioCard required>
    <RadioCardLabel>Shipping</RadioCardLabel>
  </RadioCard>
);
