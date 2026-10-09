import { writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleCode = 'effect-native(no-native-timers)';
const clockSource = "import { Clock, DateTime } from 'effect';";

it('keeps ambient caller clocks in shared factories while enforcing actual test registrations', () => {
  withTemporaryWorkspace((directory) => {
    const file = nodePath.join(directory, 'factory.ts');
    const config = fixtureConfigPath('no-native-timers');
    const diagnostics = (source: string) => {
      writeFileSync(file, source);
      return runOxlint(config, [file], appRoot).diagnostics.filter(({ code }) => code === ruleCode);
    };

    expect(diagnostics(`${clockSource}\nexport const makeSnapshot = () => DateTime.now;`)).toEqual([]);
    expect(diagnostics(`${clockSource}\nexport const readMillis = Clock.currentTimeMillis;`)).toEqual([]);

    const registered = diagnostics(
      [
        clockSource,
        "import { it as register } from 'effect-rstest';",
        "register.effect('clock', () => Clock.currentTimeMillis);",
      ].join('\n'),
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]?.message).toContain('Clock.currentTimeMillis');

    const namespace = diagnostics(
      [clockSource, "import * as runner from 'effect-rstest';", "runner.it.effect('clock', () => DateTime.now);"].join(
        '\n',
      ),
    );
    expect(namespace).toHaveLength(1);

    const nativeHelper = diagnostics('export const unmanaged = () => setTimeout(() => {}, 5);');
    expect(nativeHelper).toHaveLength(1);
    expect(nativeHelper[0]?.message).toContain('Native timer');
  });
});

it('distinguishes prepared and shadowed test APIs from invoked parameterized registrations', () => {
  withTemporaryWorkspace((directory) => {
    const file = nodePath.join(directory, 'support.ts');
    const config = fixtureConfigPath('no-native-timers');
    const diagnostics = (source: string) => {
      writeFileSync(file, source);
      return runOxlint(config, [file], appRoot).diagnostics.filter(({ code }) => code === ruleCode);
    };
    const imports = [clockSource, "import { it } from 'effect-rstest';"].join('\n');
    expect(
      diagnostics(`${imports}\nexport const prepared = it.each([1]);\nexport const stamp = DateTime.now;`),
    ).toEqual([]);
    expect(
      diagnostics(
        `${imports}\nexport function factory(it: (name: string, body: object) => void) { it('data', DateTime.now); }`,
      ),
    ).toEqual([]);
    expect(diagnostics(`${imports}\nit.each([1])('clock', () => DateTime.now);`)).toHaveLength(1);
    expect(diagnostics(`${imports}\nit.runIf(true).effect('clock', () => DateTime.now);`)).toHaveLength(1);
    expect(
      diagnostics(`${imports}\nit.layer({})((scoped) => scoped.effect('clock', () => DateTime.now));`),
    ).toHaveLength(1);

    const declaredTest = nodePath.join(directory, 'clock.test.ts');
    writeFileSync(declaredTest, `${clockSource}\nexport const stamp = DateTime.now;`);
    expect(runOxlint(config, [declaredTest], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toHaveLength(
      1,
    );
  });
});
