// expect-count: 1
// EVASION: TypeScript honours `@ts-nocheck` in a triple-slash comment too (verified with tsc:
// `/// @ts-nocheck` silences the whole file exactly like `// @ts-nocheck`), but the rule matches
// only the two-slash form because `comment.value` then starts with `/`.
/// @ts-nocheck
export const broken: number = "not a number" as unknown as number;
