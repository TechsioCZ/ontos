# ColorSelect integration contract

## Scope

This engineering contract records the shared UI component used when an authorized schema editor chooses or changes a Select, Multi-select, or Status Option color. It introduces no Task Property business behavior.

## Component decision

- Use `ColorSelect` from `@techsio/ui-kit/molecules/color-select`; do not build a custom swatch control.
- Use single selection for editing one Option color.
- Supply available colors and selected state from application configuration and handle selection through `onColorClick`.
- The component decision does not define which colors are available, how an automatic color is chosen, or how a color is persisted.

## Preserved business behavior

- Each datatype's authoritative specification continues to govern whether Options have colors, when a color is assigned, who may change it, how recoloring propagates, and whether duplication copies it.
- Color remains presentation rather than Option identity or business meaning.
- No palette, random/deterministic rule, color syntax, alpha rule, or uniqueness rule is added here.

## Ownership

- `@techsio/ui-kit` owns the reusable `ColorSelect` component.
- Select, Multi-select, and Status own their existing Option lifecycle and color behavior.

## Sources

- `../sources/product-owner/ontos-select-property.md` §F4.
- `../sources/handoffs/ontos-select-property-handoff.md`.
- `../sources/product-owner/ontos-multi-select-property.md` §§F4.5/J.H4.
- `../sources/handoffs/ontos-multi-select-ticketing-handoff.md`.
- `../sources/product-owner/ontos-status-property.md`.
- `../sources/handoffs/ontos-status-property-handoff.md`.
