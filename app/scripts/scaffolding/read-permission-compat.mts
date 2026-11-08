/**
 * The legacy read fields a generated read keeps only while it is still on an *unprotected*
 * classification (public, authenticated_principal): the permission target that decides it and the
 * positional resolver that names that target.
 *
 * A v2 `protected` read decides its own record through the access gate and `accessTarget`, so it
 * declares neither (O62, CUTOVER-PLAN §4.3). Both helpers render nothing for a protected read, so a
 * `scaffold:module-api` / governed contribution read is generated in the shape the contract now
 * expects. Both disappear with the legacy vocabulary in C03b; until then every generated read still
 * typechecks and still loads.
 */

/** The descriptor's `permissionTarget` line, or nothing for a protected read. */
export const renderLegacyReadPermissionTarget = (classification: string): string =>
  classification === 'protected' ? '' : "    permissionTarget: 'module',\n";

/**
 * The position of the permission-target resolver, including the commas that keep the call valid.
 *
 * `resultResolverFollows` keeps the positional contract intact: `defineRead` takes the permission-target
 * resolver and then the result-target resolver, so a read that drops the first but still declares the
 * second (a search provider) emits `undefined` in that slot instead of shifting the result resolver into
 * it. A protected read with no result resolver ends on the bare trailing comma the formatter writes.
 */
export const renderLegacyReadPermissionResolver = (
  classification: string,
  moduleId: string,
  options: {
    readonly indent?: string;
    readonly resultResolverFollows?: boolean;
  } = {},
): string => {
  const indent = options.indent ?? '  ';
  if (classification !== 'protected') {
    return `,\n${indent}() => ({ kind: 'module', moduleId: '${moduleId}' }),`;
  }
  return options.resultResolverFollows === true ? `,\n${indent}undefined,` : ',';
};
