// Lookalikes that oxlint does NOT treat as directives (each verified against the oxlint binary: the
// underlying violation is still reported), so the rule must not report them either.
//! oxlint-disable no-await-in-loop
/// eslint-disable no-await-in-loop
/** oxlint-disable no-await-in-loop */
/* eslint-enable no-await-in-loop */

export const emitted = "/* eslint-disable no-await-in-loop */";
export const template = `// oxlint-disable promise/avoid-new`;
