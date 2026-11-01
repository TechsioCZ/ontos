/**
 * Roles held only by non-interactive system accounts, e.g. the read-only post-deploy warm-up login of each demo
 * company. Such an account signs in like a person, but it is operated by the platform, never by the company, so
 * people administration hides it exactly like service principals.
 */
const systemServiceRolePattern = /^warmup-[a-z0-9]+(?:-[a-z0-9]+)*-reader$/u;

export const isSystemServiceRoleKey = (roleKey: string): boolean => systemServiceRolePattern.test(roleKey);
