import type { DemoGuide } from './demo-guide-types.ts';
import { akrosGuide } from './guides/akros.ts';
import { hanakGuide } from './guides/hanak.ts';
import { obchodGuide } from './guides/obchod.ts';
import { siamparkGuide } from './guides/siampark.ts';

/** Every demo guide, in presentation order. */
export const demoGuides: readonly DemoGuide[] = [siamparkGuide, hanakGuide, akrosGuide, obchodGuide];

/** Guide of the selected legal entity; `undefined` for companies without a guide or without a selection. */
export const demoGuideFor = (legalEntityId: string | undefined): DemoGuide | undefined =>
  legalEntityId === undefined ? undefined : demoGuides.find((guide) => guide.legalEntityId === legalEntityId);
