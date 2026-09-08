/* eslint-disable */
// KNOWN LIMITATION, not a blessing. The rule *does* report a bare file-wide `eslint-disable`
// (criterion "names no rules"), but oxlint applies its own directive handling before plugin
// diagnostics are collected, so a blanket disable suppresses this rule's report along with
// everything else. This workspace currently contains zero blanket disables; the fixture exists to
// pin the behaviour so a future oxlint release that stops swallowing it is noticed as a test change.
export const anything = (value: unknown): unknown => value;
