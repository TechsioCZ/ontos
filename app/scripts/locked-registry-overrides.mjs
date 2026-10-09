import { Option, Schema } from 'effect';
import { parseAllDocuments } from 'yaml';

const LockfilePackagesSchema = Schema.Struct({
  packages: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const exactRegistryVersionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u;

/**
 * Pins every package the workspace lockfile resolves to exactly one registry version, so the runtime
 * `npm install` reproduces the transitive versions pnpm verified (including its release-age gate)
 * instead of floating to whatever a caret range matches at deploy time.
 * @param {string} lockfileText - pnpm-lock.yaml contents.
 * @returns {Record<string, string>} npm overrides.
 */
export const lockedRegistryOverrides = (lockfileText) => {
  /** @type {Map<string, Set<string>>} */
  const versionsByName = new Map();
  for (const document of parseAllDocuments(lockfileText)) {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(LockfilePackagesSchema)(document.toJS()));
    const packageKeys = Object.keys(decoded?.packages ?? {});
    for (const key of packageKeys) {
      const separator = key.lastIndexOf('@');
      const name = key.slice(0, separator);
      const version = key.slice(separator + 1);
      // Reject aliased keys such as `name@npm:other@1.0.0`, whose name part would not be a package name.
      if (separator > 0 && !name.includes('@', 1) && exactRegistryVersionPattern.test(version)) {
        versionsByName.set(name, (versionsByName.get(name) ?? new Set()).add(version));
      }
    }
  }
  return Object.fromEntries(
    [...versionsByName]
      .filter(([, versions]) => versions.size === 1)
      .map(([name, versions]) => [name, [...versions][0] ?? '']),
  );
};
