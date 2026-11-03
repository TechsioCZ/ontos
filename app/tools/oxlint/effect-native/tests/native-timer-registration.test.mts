import { testEffectNativeRule, fixtureOptions, virtualFile, withOptions } from './rule-tester.mts';

const timerRule = 'no-native-timers';
const clockSource = "import { Clock, DateTime } from 'effect';";
const options = withOptions(fixtureOptions(timerRule));
const factory = virtualFile('factory.ts');
const support = virtualFile('support.ts');
const imports = [clockSource, "import { it } from 'effect-rstest';"].join('\n');

testEffectNativeRule(
  timerRule,
  {
    invalid: [
      {
        code: [
          clockSource,
          "import { it as register } from 'effect-rstest';",
          "register.effect('clock', () => Clock.currentTimeMillis);",
        ].join('\n'),
        errors: [{ message: /Clock\.currentTimeMillis/u }],
        filename: factory,
        name: 'aliased test registration reading the clock',
        ...options,
      },
      {
        code: [
          clockSource,
          "import * as runner from 'effect-rstest';",
          "runner.it.effect('clock', () => DateTime.now);",
        ].join('\n'),
        errors: 1,
        filename: factory,
        name: 'namespace test registration reading the clock',
        ...options,
      },
      {
        code: 'export const unmanaged = () => setTimeout(() => {}, 5);',
        errors: [{ message: /Native timer/u }],
        filename: factory,
        name: 'native timer in a shared factory',
        ...options,
      },
    ],
    valid: [
      {
        code: `${clockSource}\nexport const makeSnapshot = () => DateTime.now;`,
        filename: factory,
        name: 'caller clock snapshot in a shared factory',
        ...options,
      },
      {
        code: `${clockSource}\nexport const readMillis = Clock.currentTimeMillis;`,
        filename: factory,
        name: 'caller clock read in a shared factory',
        ...options,
      },
    ],
  },
  'keeps ambient caller clocks in shared factories while enforcing actual test registrations',
);

testEffectNativeRule(
  timerRule,
  {
    invalid: [
      {
        code: `${imports}\nit.each([1])('clock', () => DateTime.now);`,
        errors: 1,
        filename: support,
        name: 'invoked parameterized registration',
        ...options,
      },
      {
        code: `${imports}\nit.runIf(true).effect('clock', () => DateTime.now);`,
        errors: 1,
        filename: support,
        name: 'conditional registration',
        ...options,
      },
      {
        code: `${imports}\nit.layer({})((scoped) => scoped.effect('clock', () => DateTime.now));`,
        errors: 1,
        filename: support,
        name: 'layer-scoped registration',
        ...options,
      },
      {
        code: `${clockSource}\nexport const stamp = DateTime.now;`,
        errors: 1,
        filename: virtualFile('clock.test.ts'),
        name: 'clock read in a declared test file',
        ...options,
      },
    ],
    valid: [
      {
        code: `${imports}\nexport const prepared = it.each([1]);\nexport const stamp = DateTime.now;`,
        filename: support,
        name: 'prepared parameterized API',
        ...options,
      },
      {
        code: `${imports}\nexport function factory(it: (name: string, body: object) => void) { it('data', DateTime.now); }`,
        filename: support,
        name: 'shadowed test API parameter',
        ...options,
      },
    ],
  },
  'distinguishes prepared and shadowed test APIs from invoked parameterized registrations',
);
