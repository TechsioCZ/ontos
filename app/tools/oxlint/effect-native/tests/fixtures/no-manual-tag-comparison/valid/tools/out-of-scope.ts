/** Outside `include` (`apps|verticals|packages|scripts`): tooling is never in scope. */
export const isProblem = (error: { readonly _tag: string }): boolean => error._tag === "ShellTargetNotFoundProblem";
