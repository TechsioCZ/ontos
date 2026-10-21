import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';

import { demoGuideFor } from './demo-guide-registry.ts';
import { setDemoGuideOpen, summarizeGuideProgress, useDemoGuideProgress } from './demo-guide-store.ts';
import type { DemoGuide } from './demo-guide-types.ts';

const actionLabel = (done: number, total: number): string => {
  if (done === 0) {
    return 'Otevřít průvodce';
  }
  return done >= total ? 'Projít znovu' : 'Pokračovat v ukázce';
};

const GuideCard = ({ guide }: { readonly guide: DemoGuide }) => {
  const summary = summarizeGuideProgress(guide, useDemoGuideProgress(guide.id));
  return (
    <section
      aria-label="Průvodce ukázkou"
      className="flex w-full max-w-5xl flex-wrap items-center gap-250 rounded-lg border border-primary bg-primary-light p-300"
    >
      <span className="flex size-icon-control-lg shrink-0 items-center justify-center rounded-md bg-primary text-fg-primary">
        <Icon icon="icon-[mdi--presentation-play]" size="md" />
      </span>
      {/* Wraps by available width, not viewport: the open guide panel narrows the page on desktop. */}
      <div className="flex min-w-0 grow basis-md flex-col gap-100">
        <span className="text-fg-secondary text-xs uppercase tracking-wide">Průvodce ukázkou</span>
        <h2 className="font-semibold text-fg-primary text-xl">{`${guide.companyName}: připravená ukázka`}</h2>
        <p className="text-fg-secondary text-sm">{guide.intro}</p>
        <p className="text-fg-secondary text-xs">{`Hotovo ${summary.done} z ${summary.total} kroků`}</p>
      </div>
      <Button
        className="shrink-0"
        icon="icon-[mdi--presentation-play]"
        onClick={() => {
          setDemoGuideOpen(true);
        }}
        size="md"
        theme="solid"
        variant="primary"
      >
        {actionLabel(summary.done, summary.total)}
      </Button>
    </section>
  );
};

/** Home entry point of the guide; renders nothing for a company without a guide. */
export const DemoGuideHomeCard = ({ legalEntityId }: { readonly legalEntityId: string | undefined }) => {
  const guide = demoGuideFor(legalEntityId);
  return guide === undefined ? null : <GuideCard guide={guide} />;
};
