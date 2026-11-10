/**
 * Row events that announce an opening, for lists whose rows open a detail kept in a strict page-data store.
 *
 * A list warms its rows' details once per batch (list revision and page of rows), not again each time the 20 s
 * freshness window passes. A row opened later is warmed by these events instead: pointing at it (touch included) or
 * moving keyboard focus to it reads that row's detail, which a fresh store entry answers without a request.
 * Pass the result as the ui-kit DataTable's `slotProps.row`.
 */
export interface RowIntentProps {
  readonly onFocus: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly onPointerDown: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly onPointerEnter: (event: { readonly currentTarget: HTMLElement }) => void;
}

/** The DataTable row props that report the pointed or focused row by its position in the row model (`data-index`). */
export const rowIntentProps = (onIntent: (index: number) => void): RowIntentProps => {
  const intent = ({ currentTarget }: { readonly currentTarget: HTMLElement }) => {
    const index = Number(currentTarget.dataset['index']);
    if (Number.isInteger(index) && index >= 0) {
      onIntent(index);
    }
  };
  return { onFocus: intent, onPointerDown: intent, onPointerEnter: intent };
};
