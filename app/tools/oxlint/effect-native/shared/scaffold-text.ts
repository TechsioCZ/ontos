import type { ESTree } from '@oxlint/plugins';

export type StringNode = Extract<ESTree.Node, { type: 'TemplateLiteral' | 'Literal' }>;
const MODULE_PARENTS = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
]);
const DRIVER_BOUNDARIES = new Set([
  'VariableDeclarator',
  'ReturnStatement',
  'TemplateLiteral',
  'Program',
]);

/** Lexical masking keeps offsets/newlines; regex literals and dynamic fragments remain opaque. */
export function maskText(text: string, strings = false): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/gu,
    (value) =>
      value.startsWith('/') || strings
        ? value.replace(/[^\r\n]+/gu, (segment) => ' '.repeat(segment.length))
        : value,
  );
}
function driverCallee(callee: ESTree.Node): boolean {
  if (callee.type === 'Identifier')
    return /^(?:Error|TypeError|exec|execSync|execFile|execFileSync|spawn|spawnSync)$/u.test(
      callee.name,
    );
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'console'
  );
}
/** Excludes generator-driver prose/logging/shell arguments, not text emitted into source files. */
export function driverText(node: ESTree.Node): boolean {
  if (node.parent && MODULE_PARENTS.has(node.parent.type)) return true;
  let current = node.parent;
  while (current) {
    if (current.type === 'CallExpression' || current.type === 'NewExpression')
      return driverCallee(current.callee);
    if (DRIVER_BOUNDARIES.has(current.type)) return false;
    current = current.parent;
  }
  return false;
}
/** Interpolations are opaque one-character placeholders, never evaluated. */
export function emittedText(node: StringNode): string {
  if (node.type === 'TemplateLiteral')
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('_');
  return typeof node.value === 'string' ? node.value : '';
}
/** Cooked offsets locate whole quasis, not guessed raw-source character ranges. */
export function reportNode(node: StringNode, start: number, end: number): ESTree.Node {
  if (node.type !== 'TemplateLiteral') return node;
  let offset = 0;
  for (const quasi of node.quasis) {
    const length = (quasi.value.cooked ?? quasi.value.raw).length;
    if (start >= offset && end <= offset + length) return quasi;
    offset += length + 1;
  }
  return node;
}
