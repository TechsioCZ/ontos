/**
 * A file picked from the device, bound to one effect-form field that holds the picked files (the latest pick; empty
 * before one). The kit button opens the system file dialog through a hidden native file input; what the file holds is
 * read by the caller, which follows the field's value. Picking the same file again is a new pick.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { ButtonProps } from '@techsio/ui-kit/atoms/button';
import { Option } from 'effect';
import { Fragment, createElement, useId } from 'react';
import type { FC } from 'react';

import { useFormContext } from './form-root.ts';

type FilePickerProps = Omit<ButtonProps, 'onClick' | 'type'> & {
  /** The file types the dialog offers, as the native `accept` attribute. */
  readonly accept: string;
  /** The accessible name of the hidden file input. */
  readonly inputLabel: string;
  /** The test id of the hidden file input. */
  readonly inputTestId?: string;
};

/** The button that picks one file into the field; disabled while the form submits. */
export const FilePickerField: FC<FormReact.FieldComponentProps<readonly File[], FilePickerProps>> = ({
  field,
  props,
}) => {
  const { accept, disabled, inputLabel, inputTestId, ...button } = props;
  const { pending } = useFormContext();
  const inputId = useId();
  return createElement(
    Fragment,
    null,
    createElement(Button, {
      ...button,
      disabled: pending || disabled === true,
      onClick: () => globalThis.document.querySelector<HTMLInputElement>(`input[id="${inputId}"]`)?.click(),
      type: 'button',
    }),
    createElement('input', {
      accept,
      'aria-label': inputLabel,
      className: 'hidden',
      'data-testid': inputTestId,
      disabled: pending || disabled === true,
      id: inputId,
      name: field.path,
      onChange: (event) => {
        const picked = Option.fromNullishOr(event.currentTarget.files?.item(0));
        if (Option.isSome(picked)) {
          field.onChange([picked.value]);
          field.onBlur();
        }
        // The input forgets the pick, so choosing the same file again is a change too.
        event.currentTarget.value = '';
      },
      type: 'file',
    }),
  );
};
