import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function collectInferTypeParameterNames(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  names: Set<string>,
): void {
  if (node.type === "TSInferType") names.add(node.typeParameter.name.name);
  const record = node as unknown as Readonly<Record<string, unknown>>;
  for (const key of visitorKeys[node.type] ?? []) {
    const value = record[key];
    if (isNode(value)) {
      collectInferTypeParameterNames(value, visitorKeys, names);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      if (isNode(child)) collectInferTypeParameterNames(child, visitorKeys, names);
    }
  }
}

function collectScopedTypeParameterNames(
  node: ESTree.Node,
  descendant: ESTree.Node,
  visitorKeys: VisitorKeys,
  names: Set<string>,
): void {
  if ("typeParameters" in node) {
    for (const parameter of node.typeParameters?.params ?? []) {
      names.add(parameter.name.name);
    }
  }
  if (
    node.type === "TSMappedType" &&
    (descendant === node.nameType || descendant === node.typeAnnotation)
  ) {
    names.add(node.key.name);
  }
  if (node.type === "TSConditionalType" && descendant === node.trueType) {
    collectInferTypeParameterNames(node.extendsType, visitorKeys, names);
  }
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
): ReadonlySet<string> {
  const names = new Set<string>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;
  while (current !== null && current.type !== "Program") {
    collectScopedTypeParameterNames(current, descendant, visitorKeys, names);
    descendant = current;
    current = current.parent;
  }
  return names;
}
