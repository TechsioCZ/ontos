/**
 * A Select item whose hidden native `<option>` shows the same human label as the visible one. The ui-kit falls back
 * to `value` (an internal key such as `price-asc`) when `displayValue` is missing.
 */
export const selectItem = (value: string, label: string) => ({ displayValue: label, label, value });
