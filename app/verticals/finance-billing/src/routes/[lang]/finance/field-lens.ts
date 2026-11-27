// One part of a structured field value as a field of its own, so a composite editor renders each part through a kit
// binding while the whole value stays one effect-form field.
import type { FormReact } from '@app/core-runtime/ui/form';
import { Option } from 'effect';

/**
 * The part `key` of `field`: it shows `value` and writes a change through `onChange`, which builds the next whole
 * value (so a change can also reset other parts). The whole field's own error is shown by the composite, not by a part.
 */
export const fieldPart = <Whole, Part>(
  field: FormReact.FieldState<Whole>,
  key: string,
  value: Part,
  onChange: (next: Part) => void,
): FormReact.FieldState<Part> => ({
  ...field,
  error: Option.none(),
  onChange,
  path: `${field.path}.${key}`,
  value,
});
