import { ACCESS_RISKS } from '../../authorization/access-declaration.ts';
import type { AccessRisk } from '../model.ts';

/** Locale-free ordering: Core's listings must not depend on the host's collation. */
export const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** The wider of two risks (routine < sensitive < critical), using the declaration vocabulary once. */
export const higherRisk = (left: AccessRisk, right: AccessRisk): AccessRisk =>
  ACCESS_RISKS.indexOf(left) >= ACCESS_RISKS.indexOf(right) ? left : right;

/** The widest risk of a set, or undefined when the set names nothing (an unseen predecessor). */
export const highestRisk = (risks: readonly AccessRisk[]): AccessRisk | undefined => {
  let highest: AccessRisk | undefined;
  for (const risk of risks) {
    highest = highest === undefined ? risk : higherRisk(highest, risk);
  }
  return highest;
};
