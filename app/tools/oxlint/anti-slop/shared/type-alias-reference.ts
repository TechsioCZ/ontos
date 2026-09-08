import type { ESTree } from "@oxlint/plugins";

/** Resolve an unapplied local alias reference, excluding cycles and lexical binders. */
export function unshadowedAliasName(
  type: ESTree.TSType,
  shadowedAliases: ReadonlySet<string>,
  visited: ReadonlySet<string>,
): string | null {
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  if ((type.typeArguments?.params.length ?? 0) > 0) return null;
  const name = type.typeName.name;
  return visited.has(name) || shadowedAliases.has(name) ? null : name;
}
