/**
 * Keeps MCP read results small (a module read can be hundreds of kilobytes): lists are paged, and while the JSON is
 * over budget the largest parts are replaced by `{ _omitted, count, path }` markers the client can drill into.
 */
import { Array as Arr, Data, Option, Predicate, Record as Rec, Result, Schema } from 'effect';

export interface TruncatedPath {
  readonly offset: number;
  readonly path: string;
  readonly returned: number;
  readonly total: number;
}

/** A part of the read result left out to keep the answer small; fetch it with ontos_read {id, path}. */
export interface OmittedPath {
  /** List length or number of object keys in the original. */
  readonly count: number;
  readonly kind: 'list' | 'object';
  readonly path: string;
}

export interface ReadPaginationOptions {
  /** Where `value` sits in the full read result (ontos_read path); reported paths are prefixed with it. */
  readonly basePath?: string;
  readonly budget?: number;
  readonly limit: number;
  readonly offset: number;
}

export interface PaginatedReadResult {
  readonly data: Schema.Json;
  readonly omitted: readonly OmittedPath[];
  readonly truncated: readonly TruncatedPath[];
}

/** About 8-10k tokens of JSON: well below the MCP output caps of Claude (25k tokens) and ChatGPT. */
export const READ_CHAR_BUDGET = 24_000;
/** Lists inside list items (readings of a meter, lines of an order) keep at most this many entries. */
export const NESTED_LIST_LIMIT = 5;
const LONG_STRING = 400;
const MAX_WALK_DEPTH = 24;

const isJsonObject = Schema.is(Schema.JsonObject);
const isJsonArray = Arr.isArray<Schema.Json>;
const encodeReadResult = Schema.encodeResult(Schema.fromJsonString(Schema.Json));

// Read payloads are opaque JSON; an encoding defect stays owned by the outer SDK/HTTP boundary.
const sizeOf = (value: Schema.Json): number => Result.getOrThrow(encodeReadResult(value)).length;
const joinPath = (prefix: string, key: string): string => (prefix === '' ? key : `${prefix}.${key}`);

/** The requested path is not in the read result; `message` is Czech and lists what is there. */
export class ReadPathError extends Data.TaggedError('ReadPathError')<{ readonly message: string }> {}

const valueAt = (value: Schema.Json, key: string): Option.Option<Schema.Json> => {
  if (isJsonArray(value) && /^\d+$/u.test(key) && Number(key) < value.length) {
    return Arr.get(value, Number(key));
  }
  if (isJsonObject(value) && Object.hasOwn(value, key)) {
    return Rec.get<string, Schema.Json>(value, key);
  }
  return Option.none();
};

const availableKeys = (value: Schema.Json): string => {
  if (isJsonObject(value)) {
    return Object.keys(value).slice(0, 30).join(', ');
  }
  if (isJsonArray(value)) {
    return `indexy 0–${Math.max(value.length - 1, 0)}`;
  }
  return 'žádné';
};

/** Resolves `a.b[2].c` (or `a.b.2.c`) inside a read result. */
export const selectPath = (value: Schema.Json, path: string): Result.Result<Schema.Json, ReadPathError> => {
  const segments = path
    .replaceAll(/\[(?<index>\d+)\]/gu, '.$<index>')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  let current: Schema.Json = value;
  let walked = '';
  for (const segment of segments) {
    const next = valueAt(current, segment);
    if (Option.isNone(next)) {
      const parent = walked === '' ? '' : ` pod „${walked}“`;
      return Result.fail(
        new ReadPathError({
          message: `Cesta „${path}“ ve výsledku neexistuje (chybí „${segment}“${parent}). Dostupné: ${availableKeys(current)}.`,
        }),
      );
    }
    current = next.value;
    walked = joinPath(walked, segment);
  }
  return Result.succeed(current);
};

interface Slot {
  readonly key: string | number;
  readonly parent: Schema.JsonObject | Schema.JsonArray;
  readonly path: string;
  readonly value: Schema.Json;
}

const setSlot = (slot: Slot, next: Schema.Json): void => {
  // Every visited parent is a container created by slice; depth-limited input children are never mutated.
  Reflect.set(slot.parent, slot.key, next);
};

const containerCount = (value: Schema.Json, fallback: number): number => {
  if (isJsonArray(value)) {
    return value.length;
  }
  if (isJsonObject(value)) {
    return Object.keys(value).length;
  }
  return fallback;
};

/**
 * Keeps a read result small (design §5.3, critic: Provoz read was 390 KB):
 * 1. every list is cut to `limit` items starting at `offset`; lists inside list items keep NESTED_LIST_LIMIT items;
 * 2. while the JSON is over `budget` characters, the largest remaining list (then long text, then the largest object)
 *    is replaced by an `{_omitted, count, path}` marker; a list at the root is shortened from the end.
 * Returns a new value; the input is never mutated.
 */
export const paginateReadResult = (value: Schema.Json, options: ReadPaginationOptions): PaginatedReadResult => {
  const budget = options.budget ?? READ_CHAR_BUDGET;
  const base = options.basePath?.trim() ?? '';
  const display = (inner: string): string => {
    if (base === '') {
      return inner === '' ? '(kořen)' : inner;
    }
    if (inner === '') {
      return base;
    }
    return inner.startsWith('[') ? `${base}${inner}` : `${base}.${inner}`;
  };
  const truncated = new Map<string, TruncatedPath>();
  const omitted: OmittedPath[] = [];

  const slice = (node: Schema.Json, path: string, insideList: boolean, depth: number): Schema.Json => {
    if (depth > MAX_WALK_DEPTH) {
      return node;
    }
    if (isJsonArray(node)) {
      const offset = insideList ? 0 : options.offset;
      const limit = insideList ? Math.min(options.limit, NESTED_LIST_LIMIT) : options.limit;
      const kept = node.slice(offset, offset + limit);
      if (node.length > limit || offset > 0) {
        const pattern = insideList ? path.replaceAll(/\[\d+\]/gu, '[]') : path;
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
    if (isJsonObject(node)) {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]): [string, Schema.Json] => [
          key,
          slice(child, joinPath(path, key), insideList, depth + 1),
        ]),
      );
    }
    return node;
  };

  const root = { value: slice(value, '', false, 0) };
  const slots = (predicate: (value: Schema.Json) => boolean): Slot[] => {
    const found: Slot[] = [];
    // Paths use the indexes of the original result: lists outside list items start at `offset`.
    const visit = (node: Schema.Json, path: string, insideList: boolean, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) {
        return;
      }
      if (isJsonArray(node)) {
        const shift = insideList ? 0 : options.offset;
        for (const [index, item] of node.entries()) {
          const itemPath = `${path}[${index + shift}]`;
          if (predicate(item)) {
            found.push({ key: index, parent: node, path: itemPath, value: item });
          }
          visit(item, itemPath, true, depth + 1);
        }
      } else if (isJsonObject(node) && !Object.hasOwn(node, '_omitted')) {
        for (const [key, child] of Object.entries(node)) {
          const childPath = joinPath(path, key);
          if (predicate(child)) {
            found.push({ key, parent: node, path: childPath, value: child });
          }
          visit(child, childPath, insideList, depth + 1);
        }
      }
    };
    visit(root.value, '', false, 0);
    return found;
  };
  const originalCount = (path: string, fallback: number): number =>
    Result.match(selectPath(value, path), {
      onFailure: () => fallback,
      onSuccess: (original) => containerCount(original, fallback),
    });
  const collapseLargest = (kind: 'list' | 'object'): boolean => {
    let largest: { readonly size: number; readonly slot: Slot } | undefined;
    for (const slot of slots((node) =>
      kind === 'list' ? isJsonArray(node) && node.length > 0 : isJsonObject(node) && !Object.hasOwn(node, '_omitted'),
    )) {
      const size = sizeOf(slot.value);
      if (size > 200 && (largest === undefined || size > largest.size)) {
        largest = { size, slot };
      }
    }
    if (largest === undefined) {
      return false;
    }
    const { slot } = largest;
    const keys = isJsonObject(slot.value) ? Object.keys(slot.value) : [];
    const count = originalCount(slot.path, isJsonArray(slot.value) ? slot.value.length : keys.length);
    const marker: Schema.JsonObject =
      kind === 'list'
        ? { _omitted: 'list', count, path: display(slot.path) }
        : { _omitted: 'object', count, keys: keys.slice(0, 15), path: display(slot.path) };
    setSlot(slot, marker);
    omitted.push({ count, kind, path: display(slot.path) });
    return true;
  };

  const shrink = (): boolean => {
    if (collapseLargest('list')) {
      return true;
    }
    const long = slots((node) => Predicate.isString(node) && node.length > LONG_STRING);
    if (long.length > 0) {
      for (const slot of long) {
        if (Predicate.isString(slot.value)) {
          setSlot(slot, `${slot.value.slice(0, LONG_STRING)}…`);
        }
      }
      return true;
    }
    if (collapseLargest('object')) {
      return true;
    }
    if (isJsonArray(root.value) && root.value.length > 1) {
      root.value = root.value.slice(0, -1);
      truncated.set('', {
        offset: options.offset,
        path: display(''),
        returned: root.value.length,
        total: isJsonArray(value) ? value.length : root.value.length,
      });
      return true;
    }
    return false;
  };
  let guard = 0;
  while (sizeOf(root.value) > budget && guard < 400) {
    guard += 1;
    if (!shrink()) {
      break;
    }
  }
  const omittedPaths = new Set(omitted.map((item) => item.path));
  return {
    data: root.value,
    omitted,
    truncated: [...truncated.values()].filter((item) => !omittedPaths.has(item.path)),
  };
};

export const DEFAULT_READ_LIMIT = 25;
