import { parseSync } from 'oxc-parser';

const withoutComments = (source: string): string => {
  const parsed = parseSync('wrapper.mts', source);
  if (parsed.errors.length > 0) {
    return '';
  }
  let text = source;
  for (const comment of parsed.comments) {
    text = text.slice(0, comment.start) + ' '.repeat(comment.end - comment.start) + text.slice(comment.end);
  }
  return text;
};

const hasSharedUltramodernDispatch = (source: string): boolean =>
  source.includes("Config.string('ULTRAMODERN_CREATE_BIN')") &&
  source.includes("['ultramodern', options.command, ...forwardedArgs]") &&
  source.includes("executable: 'ultramodern-create'") &&
  source.includes('ChildProcess.make(launch.executable, launch.args,') &&
  source.includes('resolveUltramodernInvocation(options).pipe(') &&
  source.includes('Effect.flatMap(launchUltramodern)');

export const hasUltramodernSkillsDispatch = (source: string, implementation: string): boolean => {
  const wrapper = withoutComments(source);
  const runner = withoutComments(implementation);
  return (
    wrapper.includes("from './shared/ultramodern-launch.mts'") &&
    wrapper.includes("['skills', 'check',") &&
    wrapper.includes("['skills', 'install',") &&
    wrapper.includes("['ultramodern', ...skillArgs]") &&
    /ultramodernLaunch\(\s*createBin\s*,\s*ultramodernArgs\s*,\s*workspaceRoot\s*,\s*path\.sep\s*,?\s*\)/u.test(
      wrapper,
    ) &&
    wrapper.includes("Config.string('ULTRAMODERN_CREATE_BIN')") &&
    runner.includes("executable: 'ultramodern-create'") &&
    runner.includes('ChildProcess.make(launch.executable, launch.args,')
  );
};

/** Recognize the explicit wrapper contract, not a dependency mentioned in prose. */
export const hasUltramodernDispatch = (
  source: string | undefined,
  command: string,
  implementation: string | undefined,
): boolean => {
  if (source === undefined || !/^[a-z-]+$/u.test(command)) {
    return false;
  }
  const wrapper = withoutComments(source);
  if (
    new RegExp(
      `\\[\\s*['"]ultramodern['"]\\s*,\\s*['"]${command}['"]\\s*,\\s*\\.\\.\\.forwardedArgs\\s*,?\\s*\\]`,
      'u',
    ).test(wrapper)
  ) {
    return true;
  }
  if (implementation === undefined) {
    return false;
  }
  const runner = withoutComments(implementation);
  const importsRunner =
    /import\s*\{[^}]*\b(?:runUltramodernScript|resolveUltramodernInvocation)\b[^}]*\}\s*from\s*['"]\.\/shared\/ultramodern-command\.mts['"]/u.test(
      wrapper,
    );
  const invokesCommand = new RegExp(
    `(?:runUltramodernScript|resolveUltramodernInvocation)\\(\\{\\s*command:\\s*['"]${command}['"]`,
    'u',
  ).test(wrapper);
  return importsRunner && invokesCommand && hasSharedUltramodernDispatch(runner);
};
