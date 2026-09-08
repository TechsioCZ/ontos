/** Minimal glob matcher for rule path options: supports `**`, `*`, `?` and `{a,b}` alternation. */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index] ?? '';
    if (char === '*' && glob[index + 1] === '*') {
      const slashAfter = glob[index + 2] === '/';
      pattern += slashAfter ? '(?:.*/)?' : '.*';
      index += slashAfter ? 3 : 2;
      continue;
    }
    const part = globPart(glob, index, char);
    pattern += part.pattern;
    index = part.next;
  }
  return new RegExp(`^${pattern}$`, 'u');
}

function globPart(glob: string, index: number, char: string): { pattern: string; next: number } {
  if (char === '*') return { pattern: '[^/]*', next: index + 1 };
  if (char === '?') return { pattern: '[^/]', next: index + 1 };
  if (char !== '{') return { pattern: escapeRegExp(char), next: index + 1 };
  const close = glob.indexOf('}', index);
  if (close === -1) return { pattern: '\\{', next: index + 1 };
  const options = glob
    .slice(index + 1, close)
    .split(',')
    .map(escapeRegExp);
  return { pattern: `(?:${options.join('|')})`, next: close + 1 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Normalise an absolute filename to a repo-relative, forward-slash path (best effort, no fs access). */
export function normalisePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const markers = ['/apps/', '/verticals/', '/packages/', '/scripts/', '/tools/'];
  let best = -1;
  for (const marker of markers) {
    const at = unified.lastIndexOf(marker);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best === -1 ? unified : unified.slice(best + 1);
}

export function matchesAny(filename: string, globs: readonly string[]): boolean {
  const path = normalisePath(filename);
  return globs.some((glob) => globToRegExp(glob).test(path));
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec|test-d|spec-d)\.[cm]?[jt]sx?$/u;

export function isTestFile(filename: string): boolean {
  return TEST_PATH.test(normalisePath(filename));
}

export function isScriptFile(filename: string): boolean {
  return /(?:^|\/)scripts\//u.test(normalisePath(filename));
}

const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

/** Legacy source-rule normalization; scriptScope intentionally has different nested-path semantics. */
export function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

/** Match an already-normalized path without applying normalisePath a second time. */
export function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Strip fixture scaffolding first; never renormalize a relative script path around inner markers. */
export function scriptScope(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture = unified.match(
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u,
  );
  if (fixture) return fixture[1];
  if (!unified.startsWith('/') && !/^[A-Za-z]:\//u.test(unified))
    return unified.replace(/^\.\//u, '');
  const match = unified.match(/(?:^|\/)((?:apps|packages|verticals|scripts|tools)\/.*)$/u);
  return match?.[1] ?? unified;
}

export function inScriptScope(path: string): boolean {
  return /(?:^|\/)scripts\//u.test(path) && !TEST_PATH.test(path);
}

/** Last workspace marker wins (unlike normalisePath/scopePath); callers can preserve their marker list. */
export function workspacePath(
  filename: string,
  markers: readonly string[] = ['/apps/', '/verticals/', '/packages/', '/scripts/'],
): string {
  const unified = filename.replaceAll('\\', '/');
  let best = -1;
  for (const marker of markers) best = Math.max(best, unified.lastIndexOf(marker));
  return best === -1 ? normalisePath(unified) : unified.slice(best + 1);
}

/** Fixture-first normalization with an explicit repository root, retaining nested markers. */
export function rootedScopePath(filename: string, root: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture =
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u.exec(unified);
  if (fixture?.[1]) return fixture[1];
  const normalizedRoot = root.replaceAll('\\', '/');
  return unified.startsWith(normalizedRoot)
    ? unified.slice(normalizedRoot.length)
    : scopePath(unified);
}

/** Common source-rule policy; retain fixture-aware and legacy glob normalization. */
export function includesRuleFile(
  filename: string,
  options: {
    includePaths: readonly string[];
    allowPaths: readonly string[];
    ignoreTestFiles: boolean;
  },
): boolean {
  const path = `/${scopePath(filename)}`;
  return (
    matchesAny(path, options.includePaths) &&
    !matchesAny(path, options.allowPaths) &&
    !(options.ignoreTestFiles && isTestFile(path))
  );
}
