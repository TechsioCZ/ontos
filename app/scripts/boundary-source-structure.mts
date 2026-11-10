const delimiterOpenings = new Map([
  ['(', '('],
  [')', '('],
  ['[', '['],
  [']', '['],
  ['{', '{'],
  ['}', '{'],
  ['<', '<'],
  ['>', '<'],
]);

/** Delimiter traversal over source whose comments and literals are already masked.
 * Angle brackets are opt-in: declarations/parameters need generics, expressions
 * must retain comparison operators. Arrow `=>` never closes a generic argument.
 */
export class DelimiterDepth {
  private readonly depths = new Map<string, number>();
  // Counts kept beside the depths so every per-character query is O(1).
  private unbalanced = 0;
  private unmatchedCloses = 0;

  update(character: string | undefined, previous?: string, angles = false): void {
    if (character === undefined) {
      return;
    }
    if (!angles && (character === '<' || character === '>')) {
      return;
    }
    if (character === '>' && previous === '=') {
      return;
    }
    const opening = delimiterOpenings.get(character);
    if (opening === undefined) {
      return;
    }
    const delta = character === opening ? 1 : -1;
    const before = this.depths.get(opening) ?? 0;
    const after = before + delta;
    this.depths.set(opening, after);
    this.unbalanced += Number(after !== 0) - Number(before !== 0);
    this.unmatchedCloses += Number(after < 0) - Number(before < 0);
  }

  hasUnmatchedClose(): boolean {
    return this.unmatchedCloses > 0;
  }

  isTopLevel(): boolean {
    return this.unbalanced === 0;
  }
}

export const topLevelSeparators = (
  structure: string,
  separators: string,
  start = 0,
  end = structure.length,
  angles = false,
): readonly number[] => {
  const depth = new DelimiterDepth();
  const positions: number[] = [];
  for (let index = start; index < end; index += 1) {
    depth.update(structure[index], structure[index - 1], angles);
    if (depth.isTopLevel() && separators.includes(structure.charAt(index))) {
      positions.push(index);
    }
  }
  return positions;
};

/** The first entry `topLevelSeparators` would return for the same arguments, without scanning past it. */
export const firstTopLevelSeparator = (
  structure: string,
  separators: string,
  start = 0,
  end = structure.length,
  angles = false,
): number | undefined => {
  const depth = new DelimiterDepth();
  for (let index = start; index < end; index += 1) {
    depth.update(structure[index], structure[index - 1], angles);
    if (depth.isTopLevel() && separators.includes(structure.charAt(index))) {
      return index;
    }
  }
  return undefined;
};

export const matchingDelimiter = (
  structure: string,
  start: number,
  opening: string,
  closing: string,
): number | undefined => {
  let depth = 0;
  for (let index = start; index < structure.length; index += 1) {
    if (structure[index] === opening) {
      depth += 1;
    }
    if (structure[index] === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
};

export const separatedSource = (
  source: string,
  separators: readonly number[],
  start = 0,
  end = source.length,
): readonly string[] => {
  const entries: string[] = [];
  let entryStart = start;
  for (const index of [...separators, end]) {
    entries.push(source.slice(entryStart, index).trim());
    entryStart = index + 1;
  }
  return entries;
};

export const toPascalCase = (value: string): string =>
  value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');

/** Boundary bindings may arrive in PascalCase as well as canonical lowercase slugs. */
export const toCamelCase = (value: string): string => {
  const pascal = toPascalCase(value);
  return `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}`;
};
