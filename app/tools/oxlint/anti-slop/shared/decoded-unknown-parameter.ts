import type { Context, ESTree } from '@oxlint/plugins';
import { lookupVariable } from '../../effect-native/shared/bindings.ts';
import { schemaIdentity } from '../../effect-native/shared/schema-identity.ts';
import type { Parameter, ParameterOwner } from './function-parameters.ts';

type Syntax = ESTree.Node & Record<string, any>;
type SchemaShape = 'bounded' | 'unknown' | null;
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);
// The native Effect decoder exposes the parsed value and SchemaError channel.
// Promise-returning ports and similarly named local functions are not this seam.
const DECODERS = new Set(['decodeUnknownOption', 'decodeUnknownResult', 'decodeUnknownSync', 'decodeUnknownEffect']);
const SCALARS = new Set([
  'String', 'Trim', 'NonEmptyString', 'Number', 'Finite', 'Int', 'Boolean', 'BigInt', 'Null', 'Undefined',
  'DateTimeUtc', 'DateTimeUtcFromString',
]);

/** A boundary must consume every raw reference in a real native decoder in its
 * own body. A nested closure, forwarding alias, second raw use or fake decoder
 * cannot turn the owner's unknown parameter into a proved parser boundary.
 */
export function isDecodedUnknownParameter(context: Context, owner: ParameterOwner, parameter: Parameter): boolean {
  if (!FUNCTIONS.has(owner.type) || parameter.type !== 'Identifier') return false;
  const variable = lookupVariable(context, parameter);
  if (variable === null || variable.references.length === 0) return false;

  const constInitializer = (node: Syntax): Syntax | null => {
    if (node.type !== 'Identifier') return null;
    const binding = lookupVariable(context, node);
    if (binding === null || binding.references.some((reference) => reference.isWrite() && !reference.init)) return null;
    const definition = binding.defs[0];
    return definition?.type === 'Variable' && definition.node.type === 'VariableDeclarator' &&
      definition.node.id.type === 'Identifier' && definition.node.parent?.type === 'VariableDeclaration' &&
      definition.node.parent.kind === 'const' ? definition.node.init as Syntax | null : null;
  };
  const shape = (node: Syntax, seen = new Set<Syntax>()): SchemaShape => {
    if (seen.has(node) || seen.size > 16) return null;
    const next = new Set(seen).add(node);
    const identity = schemaIdentity(context, node);
    if (identity === 'Unknown' || identity === 'Any') return 'unknown';
    if (identity !== null && SCALARS.has(identity)) return 'bounded';
    if (node.type === 'Identifier') {
      const initializer = constInitializer(node);
      return initializer === null ? null : shape(initializer, next);
    }
    if (node.type !== 'CallExpression') return null;
    const operation = schemaIdentity(context, node.callee);
    if (operation === 'Struct' && node.arguments.length === 1 && node.arguments[0]?.type === 'ObjectExpression') {
      const fields = node.arguments[0].properties;
      // Unknown slice/error values are deliberate at an owner-key projection
      // boundary. The nonempty Struct still validates object shape and key
      // presence/optionality; a top-level Unknown/Any schema proves nothing.
      return fields.length > 0 && fields.every((field: Syntax) => field.type === 'Property' &&
        !field.computed && !field.method && field.kind === 'init' &&
        (field.key.type === 'Identifier' || (field.key.type === 'Literal' && typeof field.key.value === 'string')) &&
        shape(field.value, new Set(next)) !== null) ? 'bounded' : null;
    }
    if (['optional', 'optionalKey', 'NullOr', 'UndefinedOr'].includes(operation ?? '') && node.arguments.length === 1)
      return shape(node.arguments[0], next);
    if (operation === 'Literal' && node.arguments.length === 1 && node.arguments[0]?.type === 'Literal') return 'bounded';
    if (operation === 'Literals' && node.arguments.length === 1 && node.arguments[0]?.type === 'ArrayExpression')
      return node.arguments[0].elements.length > 0 &&
        node.arguments[0].elements.every((element: Syntax | null) => element?.type === 'Literal') ? 'bounded' : null;
    if (operation === 'Union' && node.arguments.length === 1 && node.arguments[0]?.type === 'ArrayExpression')
      return node.arguments[0].elements.length > 0 && node.arguments[0].elements.every((element: Syntax | null) =>
        element !== null && shape(element, new Set(next)) === 'bounded') ? 'bounded' : null;
    if (node.callee.type !== 'MemberExpression' || node.callee.computed) return null;
    if (node.callee.property.name === 'check') return shape(node.callee.object, next);
    if (node.callee.property.name === 'pipe' && node.arguments.every((argument: Syntax) =>
      argument.type === 'CallExpression' && schemaIdentity(context, argument.callee) === 'brand'))
      return shape(node.callee.object, next);
    return null;
  };
  const decoderSchema = (node: Syntax, seen = new Set<Syntax>()): Syntax | null => {
    if (seen.has(node) || seen.size > 16) return null;
    const next = new Set(seen).add(node);
    if (node.type === 'Identifier') {
      const initializer = constInitializer(node);
      return initializer === null ? null : decoderSchema(initializer, next);
    }
    return node.type === 'CallExpression' && DECODERS.has(schemaIdentity(context, node.callee) ?? '') &&
      node.arguments.length === 1 && node.arguments[0]?.type !== 'SpreadElement' ? node.arguments[0] : null;
  };
  return variable.references.every((reference) => {
    const identifier = reference.identifier;
    let enclosing = identifier.parent;
    while (enclosing !== null && enclosing !== undefined && !FUNCTIONS.has(enclosing.type)) enclosing = enclosing.parent;
    if (enclosing !== owner || reference.isWrite()) return false;
    const call = identifier.parent;
    if (call?.type !== 'CallExpression' || call.arguments.length !== 1 || call.arguments[0] !== identifier) return false;
    const schema = decoderSchema(call.callee as Syntax);
    return schema !== null && shape(schema) === 'bounded';
  });
}
