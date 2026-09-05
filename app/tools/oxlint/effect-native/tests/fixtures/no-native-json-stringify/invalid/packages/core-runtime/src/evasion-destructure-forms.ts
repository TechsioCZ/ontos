// expect-count: 4
// The destructured `JSON` bag in every binding form.
declare const v: unknown;

const { stringify: fromGlobalThis } = globalThis.JSON;

const { ["stringify"]: fromComputedKey } = JSON;

const { stringify: fromRestPattern, ...rest } = JSON;

let fromAssignment: (value: unknown) => string;
({ stringify: fromAssignment } = JSON);

export const used = [fromGlobalThis, fromComputedKey, fromRestPattern, fromAssignment, rest, v];
