import { comboboxTranslations } from '@app/admin-ui';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { FocusEvent, ReactNode } from 'react';

interface PickerItem {
  readonly label: string;
  readonly value: string;
}

interface PickerOptions {
  /** The options shown now. The list is filtered by the typed text, so it may lack the chosen one. */
  readonly items: readonly PickerItem[];
  /** Every change of the typed text, also when it goes back to the chosen option's label. */
  readonly onTextChange?: (text: string) => void;
  /** The chosen value of the bound field; `""` is none. */
  readonly value: string;
}

/**
 * The typed text of a bound ui-kit Combobox that picks one value, as the Selects next to it behave: the list opens on
 * a click into the text field, and there is never a clear button, because zag names it "Clear value" in English and
 * ui-kit offers no prop for a Czech label. Deleting the text or picking another option replaces the value instead.
 *
 * Typed text that picked nothing is dropped on Escape and when focus leaves the field (`PickerFrame`): the text goes
 * back to the chosen option's label, or empty when none is chosen. zag only does that while its list is open, so text
 * typed after Escape closed the list stayed in the field, where it looked like an applied filter.
 *
 * Spread `props` on the bound combobox field; `text` is the typed text, for a list filtered outside the Combobox.
 */
export const usePicker = ({ items, onTextChange, value }: PickerOptions) => {
  // `undefined` until zag reports the first text, so the field starts from zag's own initial value.
  const [inputText, setInputText] = useState<string>();
  /** Labels of every option seen so far. The list is filtered by the typed text, so it may lack the chosen one. */
  const labelsRef = useRef(new Map<string, string>());
  useEffect(() => {
    for (const item of items) {
      labelsRef.current.set(item.value, item.label);
    }
  }, [items]);

  const changeText = (next: string) => {
    setInputText(next);
    onTextChange?.(next);
  };

  const restore = () => {
    const chosenLabel = value === '' ? '' : (labelsRef.current.get(value) ?? '');
    if (inputText !== undefined && inputText !== chosenLabel) {
      changeText(chosenLabel);
    }
  };

  const shared = {
    clearable: false,
    onInputValueChange: changeText,
    openOnClick: true,
    translations: comboboxTranslations,
  } as const;
  return {
    /** Sets the typed text, such as clearing it once the picked option was used. */
    changeText,
    props: inputText === undefined ? shared : { ...shared, inputValue: inputText },
    restore,
    text: inputText ?? '',
  };
};

/** Drops typed text that picked nothing on Escape and when focus leaves the combobox it wraps. */
export const PickerFrame = ({
  children,
  picker,
}: {
  readonly children: ReactNode;
  readonly picker: Pick<ReturnType<typeof usePicker>, 'restore'>;
}) => {
  const fieldRef = useRef<HTMLDivElement>(null);
  const revertInputText = useEffectEvent(picker.restore);

  useEffect(() => {
    const field = fieldRef.current;
    const revertOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        revertInputText();
      }
    };
    field?.addEventListener('keydown', revertOnEscape);
    return () => {
      field?.removeEventListener('keydown', revertOnEscape);
    };
  }, []);

  // Options keep focus on the input when clicked, so focus leaving the wrapper means leaving the field.
  const revertOnLeave = (event: FocusEvent<HTMLDivElement>) => {
    if (fieldRef.current?.contains(event.relatedTarget) !== true) {
      picker.restore();
    }
  };

  return (
    <div onBlur={revertOnLeave} ref={fieldRef}>
      {children}
    </div>
  );
};
