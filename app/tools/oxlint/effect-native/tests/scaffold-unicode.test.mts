import { describe, expect, it } from 'effect-rstest';

import { maskText } from '../shared/scaffold-text.ts';
import { testEffectNativeRule, virtualFile } from './rule-tester.mts';

const supplementaryCharacter = '\u{1F600}';
const environmentAccess = 'process.env.X';

// The source covers every masked form the pattern accepts: a line comment, a block comment that
// spans a CRLF, and a quoted literal, each carrying supplementary characters. Asserting the offset
// of the trailing access, rather than only the masked length, is what catches an over-greedy match
// that swallows the code following a comment.
it('scaffold masking preserves UTF-16 offsets and line endings', () => {
  const source = `// ${supplementaryCharacter}\r\n/* ${supplementaryCharacter}\r\n */ const label="${supplementaryCharacter.repeat(20)}"; process.env.X`;
  for (const strings of [false, true]) {
    const masked = maskText(source, strings);
    expect(masked.length).toBe(source.length);
    expect([...masked.matchAll(/\r\n/gu)].map((match) => match.index)).toStrictEqual(
      [...source.matchAll(/\r\n/gu)].map((match) => match.index),
    );
    expect(masked.indexOf(environmentAccess)).toBe(source.indexOf(environmentAccess));
    expect(masked.endsWith(environmentAccess)).toBeTruthy();
    expect(masked.includes(supplementaryCharacter)).toBe(!strings);
  }
});

describe('manual configuration rule detects access after supplementary Unicode but ignores quoted data', () => {
  const prefix = `const label="${supplementaryCharacter.repeat(20)}"; `;
  testEffectNativeRule('no-manual-config-in-scaffold-templates', {
    invalid: [
      {
        code: `export const source = \`${prefix}process.env.X${' '.repeat(30)}\`;`,
        errors: 1,
        filename: virtualFile('scripts/scaffolding/unicode-positive.mts'),
      },
    ],
    valid: [
      {
        code: `export const source = \`${prefix}const example = "process.env.X";\`;`,
        filename: virtualFile('scripts/scaffolding/unicode-negative.mts'),
      },
    ],
  });
});
