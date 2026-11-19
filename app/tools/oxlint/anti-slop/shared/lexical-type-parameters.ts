import type { ESTree } from "@oxlint/plugins";

/*
 * Adapted from @nkzw/oxlint-config 3.0.0 `quality/shared/lexical-type-parameters.js`
 * (MIT, Nakazawa Tech; quality rules derived from anti-slop, MIT, Dillon Mulroy). Nested
 * conditional types own the `infer` binders of their own `extends` clause.
 */

export type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function childNodes(node: ESTree.Node, visitorKeys: VisitorKeys): ESTree.Node[] {
  // Parser-node boundary: visitor keys name exactly the child fields of each ESTree node type.
  const fields = node as unknown as Readonly<Record<string, unknown>>;
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = fields[key];
    if (isNode(value)) return [value];
    return Array.isArray(value) ? value.filter(isNode) : [];
  });
}

/** Whether `type` declares `infer name` for the conditional type whose extends clause it is in. */
function declaresInfer(type: ESTree.Node, name: string, visitorKeys: VisitorKeys): boolean {
  if (type.type === "TSInferType" && type.typeParameter.name.name === name) return true;
  return childNodes(type, visitorKeys).some(
    (child) =>
      !(type.type === "TSConditionalType" && child === type.extendsType) &&
      declaresInfer(child, name, visitorKeys),
  );
}

/**
 * Whether `node` introduces a type parameter `name` that is visible in its child `child`: a
 * generic declaration, a mapped type key, or an `infer` binder in a conditional true branch.
 */
export function bindsTypeParameter(
  node: ESTree.Node,
  child: ESTree.Node | null,
  name: string,
  visitorKeys: VisitorKeys,
): boolean {
  if (
    "typeParameters" in node &&
    node.typeParameters?.params.some((parameter) => parameter.name.name === name) === true
  ) {
    return true;
  }
  if (node.type === "TSMappedType") {
    return node.key.name === name && (child === node.nameType || child === node.typeAnnotation);
  }
  return (
    node.type === "TSConditionalType" &&
    child === node.trueType &&
    declaresInfer(node.extendsType, name, visitorKeys)
  );
}
