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
    if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else if (char === '{') {
      const close = glob.indexOf('}', index);
      if (close === -1) pattern += '\\{';
      else {
        const options = glob
          .slice(index + 1, close)
          .split(',')
          .map(escapeRegExp);
        pattern += `(?:${options.join('|')})`;
        index = close + 1;
        continue;
      }
    } else pattern += escapeRegExp(char);
    index += 1;
  }
  return new RegExp(`^${pattern}$`, 'u');
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
  return normalisePath(filename).startsWith('scripts/');
}
