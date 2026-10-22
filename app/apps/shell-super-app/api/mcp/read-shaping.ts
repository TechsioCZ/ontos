/**
 * Keeps MCP read results small (a module read can be hundreds of kilobytes): lists are paged, and while the JSON is
 * over budget the largest parts are replaced by `{ _omitted, count, path }` markers the client can drill into.
 */
import { Data, Result } from 'effect';

export interface TruncatedPath {
  readonly path: string;
  readonly total: number;
  readonly offset: number;
  readonly returned: number;
}

/** A part of the read result left out to keep the answer small; fetch it with ontos_read {id, path}. */
export interface OmittedPath {
  readonly path: string;
  readonly kind: 'list' | 'object';
  /** List length or number of object keys in the original. */
  readonly count: number;
}

/** About 8-10k tokens of JSON: well below the MCP output caps of Claude (25k tokens) and ChatGPT. */
export const READ_CHAR_BUDGET = 24_000;
/** Lists inside list items (readings of a meter, lines of an order) keep at most this many entries. */
export const NESTED_LIST_LIMIT = 5;
const LONG_STRING = 400;
const MAX_WALK_DEPTH = 24;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sizeOf = (value: unknown): number => JSON.stringify(value)?.length ?? 0;
const joinPath = (prefix: string, key: string): string => (prefix === '' ? key : `${prefix}.${key}`);

/** The requested path is not in the read result; `message` is Czech and lists what is there. */
export class ReadPathError extends Data.TaggedError('ReadPathError')<{ readonly message: string }> {}

/** Resolves `a.b[2].c` (or `a.b.2.c`) inside a read result. */
export const selectPath = (value: unknown, path: string): Result.Result<unknown, ReadPathError> => {
  const segments = path
    .replace(/\[(\d+)\]/gu, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  let current: unknown = value;
  let walked = '';
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/u.test(segment) && Number(segment) < current.length) {
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      const keys = isPlainObject(current)
        ? Object.keys(current).slice(0, 30).join(', ')
        : Array.isArray(current)
          ? `indexy 0–${Math.max(current.length - 1, 0)}`
          : 'žádné';
      return Result.fail(
        new ReadPathError({
          message: `Cesta „${path}“ ve výsledku neexistuje (chybí „${segment}“${walked === '' ? '' : ` pod „${walked}“`}). Dostupné: ${keys}.`,
        }),
      );
    }
    walked = joinPath(walked, segment);
  }
  return Result.succeed(current);
};

type Mutable = Record<string, unknown> | unknown[];
interface Slot {
  readonly parent: Mutable;
  readonly key: string | number;
  readonly path: string;
  readonly value: unknown;
}

/**
 * Keeps a read result small (design §5.3, critic: Provoz read was 390 KB):
 * 1. every list is cut to `limit` items starting at `offset`; lists inside list items keep NESTED_LIST_LIMIT items;
 * 2. while the JSON is over `budget` characters, the largest remaining list (then long text, then the largest object)
 *    is replaced by an `{_omitted, count, path}` marker; a list at the root is shortened from the end.
 * Returns a new value; the input is never mutated.
 */
export const shapeReadResult = (
  value: unknown,
  options: {
    readonly limit: number;
    readonly offset: number;
    readonly budget?: number;
    /** Where `value` sits in the full read result (ontos_read path); reported paths are prefixed with it. */
    readonly basePath?: string;
  },
): {
  readonly data: unknown;
  readonly truncated: readonly TruncatedPath[];
  readonly omitted: readonly OmittedPath[];
} => {
  const budget = options.budget ?? READ_CHAR_BUDGET;
  const base = options.basePath?.trim() ?? '';
  const display = (inner: string): string =>
    base === ''
      ? inner === ''
        ? '(kořen)'
        : inner
      : inner === ''
        ? base
        : inner.startsWith('[')
          ? `${base}${inner}`
          : `${base}.${inner}`;
  const truncated = new Map<string, TruncatedPath>();
  const omitted: OmittedPath[] = [];

  const slice = (node: unknown, path: string, insideList: boolean, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH) {
      return node;
    }
    if (Array.isArray(node)) {
      const offset = insideList ? 0 : options.offset;
      const limit = insideList ? Math.min(options.limit, NESTED_LIST_LIMIT) : options.limit;
      const kept = node.slice(offset, offset + limit);
      if (node.length > limit || offset > 0) {
        const pattern = insideList ? path.replace(/\[\d+\]/gu, '[]') : path;
        const previous = truncated.get(pattern);
        truncated.set(pattern, {
          offset,
          path: display(pattern),
          returned: kept.length,
          total: Math.max(node.length, previous?.total ?? 0),
        });
      }
      return kept.map((item, index) => slice(item, `${path}[${offset + index}]`, true, depth + 1));
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = slice(child, joinPath(path, key), insideList, depth + 1);
      }
      return out;
    }
    return node;
  };

  const root = { value: slice(value, '', false, 0) };
  const slots = (predicate: (value: unknown) => boolean): Slot[] => {
    const found: Slot[] = [];
    // Paths use the indexes of the original result: lists outside list items start at `offset`.
    const visit = (node: unknown, path: string, insideList: boolean, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) {
        return;
      }
      if (Array.isArray(node)) {
        const shift = insideList ? 0 : options.offset;
        node.forEach((item, index) => {
          const itemPath = `${path}[${index + shift}]`;
          if (predicate(item)) {
            found.push({ key: index, parent: node, path: itemPath, value: item });
          }
          visit(item, itemPath, true, depth + 1);
        });
      } else if (isPlainObject(node) && !Object.hasOwn(node, '_omitted')) {
        for (const [key, child] of Object.entries(node)) {
          const childPath = joinPath(path, key);
          if (predicate(child)) {
            found.push({ key, parent: node as Record<string, unknown>, path: childPath, value: child });
          }
          visit(child, childPath, insideList, depth + 1);
        }
      }
    };
    visit(root.value, '', false, 0);
    return found;
  };
  const setSlot = (slot: Slot, next: unknown): void => {
    if (Array.isArray(slot.parent)) {
      slot.parent[slot.key as number] = next;
    } else {
      slot.parent[slot.key as string] = next;
    }
  };
  const originalCount = (path: string, fallback: number): number =>
    Result.match(selectPath(value, path), {
      onFailure: () => fallback,
      onSuccess: (original) =>
        Array.isArray(original) ? original.length : isPlainObject(original) ? Object.keys(original).length : fallback,
    });
  const collapseLargest = (kind: 'list' | 'object'): boolean => {
    const candidates = slots((node) =>
      kind === 'list'
        ? Array.isArray(node) && node.length > 0
        : isPlainObject(node) && !Object.hasOwn(node, '_omitted'),
    )
      .map((slot) => ({ size: sizeOf(slot.value), slot }))
      .filter((candidate) => candidate.size > 200)
      .sort((left, right) => right.size - left.size);
    const [largest] = candidates;
    if (largest === undefined) {
      return false;
    }
    const { slot } = largest;
    const count = originalCount(
      slot.path,
      Array.isArray(slot.value) ? slot.value.length : Object.keys(slot.value as object).length,
    );
    const marker =
      kind === 'list'
        ? { _omitted: 'list', count, path: display(slot.path) }
        : { _omitted: 'object', count, keys: Object.keys(slot.value as object).slice(0, 15), path: display(slot.path) };
    setSlot(slot, marker);
    omitted.push({ count, kind, path: display(slot.path) });
    return true;
  };

  let guard = 0;
  while (sizeOf(root.value) > budget && guard < 400) {
    guard += 1;
    if (collapseLargest('list')) {
      continue;
    }
    const long = slots((node) => typeof node === 'string' && node.length > LONG_STRING);
    if (long.length > 0) {
      long.forEach((slot) => setSlot(slot, `${(slot.value as string).slice(0, LONG_STRING)}…`));
      continue;
    }
    if (collapseLargest('object')) {
      continue;
    }
    if (Array.isArray(root.value) && root.value.length > 1) {
      root.value.pop();
      truncated.set('', {
        offset: options.offset,
        path: display(''),
        returned: root.value.length,
        total: Array.isArray(value) ? value.length : root.value.length,
      });
      continue;
    }
    break;
  }
  const omittedPaths = new Set(omitted.map((item) => item.path));
  return {
    data: root.value,
    omitted,
    truncated: [...truncated.values()].filter((item) => !omittedPaths.has(item.path)),
  };
};

export const DEFAULT_READ_LIMIT = 25;
