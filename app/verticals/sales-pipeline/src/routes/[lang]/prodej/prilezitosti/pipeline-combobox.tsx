import { comboboxTranslations } from '@app/admin-ui';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { FocusEvent } from 'react';

/**
 * ui-kit Combobox that opens its list on a click into the text field, like the Selects next to it. ui-kit does not
 * forward zag's `openOnClick`, so this component holds the open state and opens the list on that click.
 * It never shows ui-kit's clear button, because zag names it "Clear value" in English and ui-kit offers no prop
 * for a Czech label. Deleting the text or picking another option replaces the value instead.
 *
 * Typed text that picked nothing is dropped on Escape and when focus leaves the field: the text goes back to the
 * chosen option's label, or empty when none is chosen. zag only does that while its list is open, so text typed
 * after Escape closed the list stayed in the field, where it looked like an applied filter.
 */
export const PickerCombobox = <T,>(props: ComboboxProps<T>) => {
  const { items, onInputValueChange, onOpenChange, value } = props;
  const [open, setOpen] = useState(false);
  // `undefined` until zag reports the first text, so the field starts from zag's own initial value.
  const [inputText, setInputText] = useState<string>();
  const fieldRef = useRef<HTMLDivElement>(null);
  /** Labels of every option seen so far. The list is filtered by the typed text, so it may lack the chosen one. */
  const labelsRef = useRef(new Map<string, string>());
  useEffect(() => {
    for (const item of items ?? []) {
      labelsRef.current.set(item.value, item.label);
    }
  }, [items]);

  const changeInputText = (next: string) => {
    setInputText(next);
    onInputValueChange?.(next);
  };

  const restoreChosenLabel = () => {
    const chosen = Array.isArray(value) ? value[0] : value;
    const chosenLabel = chosen === undefined || chosen === '' ? '' : (labelsRef.current.get(chosen) ?? '');
    if (inputText !== undefined && inputText !== chosenLabel) {
      changeInputText(chosenLabel);
    }
  };
  const revertInputText = useEffectEvent(restoreChosenLabel);

  useEffect(() => {
    const field = fieldRef.current;
    // A native listener on the wrapper only sees clicks inside it. React would also deliver clicks on the
    // portalled options, which must not reopen the list they just closed.
    const openOnFieldClick = (event: MouseEvent) => {
      const input = field?.querySelector<HTMLInputElement>('input[role="combobox"]');
      if (input !== null && input !== undefined && event.target === input && !input.disabled && !input.readOnly) {
        setOpen(true);
      }
    };
    const revertOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        revertInputText();
      }
    };
    field?.addEventListener('click', openOnFieldClick);
    field?.addEventListener('keydown', revertOnEscape);
    return () => {
      field?.removeEventListener('click', openOnFieldClick);
      field?.removeEventListener('keydown', revertOnEscape);
    };
  }, []);

  // Options keep focus on the input when clicked, so focus leaving the wrapper means leaving the field.
  const revertOnLeave = (event: FocusEvent<HTMLDivElement>) => {
    if (fieldRef.current?.contains(event.relatedTarget) !== true) {
      restoreChosenLabel();
    }
  };

  return (
    <div onBlur={revertOnLeave} ref={fieldRef}>
      <Combobox
        translations={comboboxTranslations}
        {...props}
        clearable={false}
        {...(inputText === undefined ? {} : { inputValue: inputText })}
        onInputValueChange={changeInputText}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
        open={open}
      />
    </div>
  );
};
