import { isComposingEvent } from "@zag-js/dom-query";

type SearchKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "preventDefault" | "shiftKey"
> & {
  currentTarget: {
    form: Pick<HTMLFormElement, "requestSubmit"> | null;
    getAttribute: Element["getAttribute"];
  };
  nativeEvent: Pick<KeyboardEvent, "isComposing">;
};

/** Keep highlighted results native; submit free text before the combobox consumes Enter. */
export const submitSearchOnEnter = (event: SearchKeyEvent) => {
  const { form } = event.currentTarget;
  const highlighted = event.currentTarget.getAttribute("aria-activedescendant");
  if (
    form === null ||
    event.defaultPrevented ||
    event.key !== "Enter" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isComposingEvent(event.nativeEvent) ||
    (highlighted !== null && highlighted !== "")
  ) {
    return;
  }
  event.preventDefault();
  form.requestSubmit();
};
