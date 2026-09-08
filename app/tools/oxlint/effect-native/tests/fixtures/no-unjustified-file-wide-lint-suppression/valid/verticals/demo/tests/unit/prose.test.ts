/**
 * Documentation may mention eslint-disable and oxlint-disable without becoming a directive.
 * A nested body line such as
 *   eslint-disable promise/avoid-new
 * is prose, not a suppression, because the comment does not start with the directive.
 */
// This test explains why we do not use eslint-disable blocks here.
/* eslint-enable no-await-in-loop */
// @ts-expect-error -- The deliberately malformed cast is the subject of this assertion.
export const malformed: string = 1 as unknown as string;
