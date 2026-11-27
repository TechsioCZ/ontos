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

/*
 * Calm surfaces: one outlined level, tints inside it, hairline dividers. The kit's `surface-card` and `surface-tile`
 * carry the nesting rules, so nesting never stacks outlines, whatever module renders the inner block.
 */

/** The one outlined level: white, one light hairline. A card inside a card (or a side panel) loses outline and padding. */
export const surfaceCardClassName = 'surface-card';

/** A tinted block without an outline: KPI tile, list item, note, filter bar. A tile inside a tile turns white. */
export const surfaceTileClassName = 'surface-tile';

/** Hairline dividers between stacked rows inside one surface. */
export const dividedListClassName = 'divide-y divide-border-primary/60';

/** Colour for a single remaining edge (section break, header rule). Pair with `border-t` or `border-b`. */
export const dividerColorClassName = 'border-border-primary/60';