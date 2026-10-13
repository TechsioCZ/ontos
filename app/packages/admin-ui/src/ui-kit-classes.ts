/**
 * Class names that adjust @techsio/ui-kit 0.56.0 layouts for Czech content. Every value is a module constant;
 * the shell's Tailwind build scans this package, so the classes exist in every remote.
 */

/**
 * `<DatePicker.Segments className={datePickerSegmentsClassName} />`. ui-kit gives every segment a two-digit minimum
 * width and centres its text, so a one-digit day or month in the cs-CZ format reads `1 .11.2025`. Segments size to
 * their text with a 1 px inset, so the date reads `1.11.2025`. The selector reaches the segments of both the single
 * picker and the two groups of a range picker (the task form's local `[&>[data-type]]` class only covers the first).
 */
export const datePickerSegmentsClassName = '[&_[data-part=segment]]:min-w-0 [&_[data-part=segment]]:px-px';
