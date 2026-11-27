/**
 * A file chosen with the browser's file picker, bound to one effect-form field that holds the chosen `File` (or
 * `null`). The picker itself is hidden: the module renders the visible control through `children`, which gets
 * `pick` to open it (such as a kit button), or wraps the field in a `<label>` whose content the person clicks. A
 * module hands it to `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Fragment, createElement, useState } from 'react';
import type { ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

interface FileProps {
  readonly accept?: string;
  readonly 'aria-label'?: string;
  /** The visible control; `pick` opens the file picker. */
  readonly children?: (pick: () => void) => ReactNode;
  /** The class of the hidden picker, such as `sr-only` or `hidden`. */
  readonly className?: string;
  readonly 'data-testid'?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly tabIndex?: number;
}

/**
 * One file. Choosing a file sets the field; the picker is cleared at once, so choosing the same file again is a
 * change too.
 */
export const FileField: FormReact.FieldComponent<File | null, FileProps> = ({ field, props }) => {
  const { pending } = useFormContext();
  const [element, setElement] = useState<HTMLInputElement | null>(null);
  const { children, className = 'sr-only', disabled, ...rest } = props;
  const picker = createElement('input', {
    ...rest,
    className,
    disabled: pending || disabled,
    name: field.path,
    onChange: (event: { readonly currentTarget: HTMLInputElement }) => {
      const chosen = event.currentTarget.files?.[0] ?? null;
      event.currentTarget.value = '';
      field.onChange(chosen);
      field.onBlur();
    },
    ref: setElement,
    type: 'file',
  });
  return createElement(
    Fragment,
    null,
    picker,
    children?.(() => {
      element?.click();
    }),
  );
};
