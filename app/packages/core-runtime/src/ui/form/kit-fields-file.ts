/**
 * A file chosen with the kit FileUpload's picker, bound to one effect-form field that holds the chosen `File` (or
 * `null`). The picker itself is hidden: the module renders the visible control through `children`, which gets
 * `pick` to open it (such as a kit button), or points a kit `Label` at the field's `id`. A module hands it to
 * `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FileUpload } from '@techsio/ui-kit/molecules/file-upload';
import type { FileUploadProps } from '@techsio/ui-kit/molecules/file-upload';
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
  /** The picker's id, for a `Label` that opens it. */
  readonly id?: string;
  /** The kit keeps its picker out of the tab order, so -1 is the only value. */
  readonly tabIndex?: -1;
}

/**
 * One file. Choosing a file sets the field; the kit holds no files of its own, so choosing the same file again is a
 * change too. The picker's root has no box (`contents`): the visible control lays out where the module puts it.
 */
export const FileField: FormReact.FieldComponent<File | null, FileProps> = ({ field, props }) => {
  const { pending } = useFormContext();
  const [element, setElement] = useState<HTMLInputElement | null>(null);
  const { accept, children, className, disabled, id, tabIndex: _tabIndex, ...rest } = props;
  const upload: FileUploadProps = {
    accept,
    acceptedFiles: [],
    className: 'contents',
    disabled: pending || disabled === true,
    name: field.path,
    onFileAccept: ({ files }) => {
      field.onChange(files[0] ?? null);
      field.onBlur();
    },
  };
  if (id !== undefined) {
    upload.ids = { hiddenInput: id };
  }
  const picker = createElement(
    FileUpload,
    upload,
    createElement(FileUpload.HiddenInput, { ...rest, className, ref: setElement }),
  );
  return createElement(
    Fragment,
    null,
    picker,
    children?.(() => {
      element?.click();
    }),
  );
};
