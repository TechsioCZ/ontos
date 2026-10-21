import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { ActionIcon } from '@techsio/ui-kit/atoms/action-icon';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Checkbox } from '@techsio/ui-kit/atoms/checkbox';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';

import {
  clampGuideWidth,
  resetDemoGuideProgress,
  setDemoGuideOpen,
  setDemoGuideProgress,
  setDemoGuideWidth,
  summarizeGuideProgress,
  toggleStep,
  useDemoGuideProgress,
  useDemoGuideWidth,
} from './demo-guide-store.ts';
import { demoPasswordHint } from './demo-guide-types.ts';
import type { DemoGuide, DemoGuideBoundaries, DemoGuidePersona, DemoGuideStep } from './demo-guide-types.ts';

export const demoGuidePanelId = 'demo-guide-panel';
const guideIcon = 'icon-[mdi--presentation-play]';
/** Same breakpoint as the shell's `lg:` utilities: below it the panel covers the page. */
const desktopQuery = '(min-width: 64rem)';
const widthStep = 32;

const isDesktop = (): boolean => globalThis.matchMedia(desktopQuery).matches;

/** Marks the routed page column; the panel measures where it starts to keep the page readable. */
export const demoGuidePageAttribute = 'data-demo-guide-page';

/** Width the page column and the panel share: viewport minus the docked navigation sidebar. */
const sharedWidth = (): number => {
  const page = globalThis.document.querySelector(`[${demoGuidePageAttribute}]`);
  return globalThis.innerWidth - (page?.getBoundingClientRect().left ?? 0);
};

/** Width the panel really has on screen; the stored width can be wider than a smaller viewport allows. */
const renderedWidth = (handle: HTMLElement, fallback: number): number =>
  handle.closest('aside')?.getBoundingClientRect().width ?? fallback;

/**
 * Scroll offset of the step list per guide. Route changes remount the shell frame and closing the panel on a phone
 * unmounts it, so the offset lives in session storage: the presenter finds the same step again after each screen.
 */
const scrollKey = (guideId: string): string => `ontos.demo-guide.scroll.${guideId}`;
const readScroll = (guideId: string): number => {
  try {
    return Number(globalThis.sessionStorage.getItem(scrollKey(guideId))) || 0;
  } catch {
    return 0;
  }
};
const writeScroll = (guideId: string, top: number): void => {
  try {
    globalThis.sessionStorage.setItem(scrollKey(guideId), String(Math.round(top)));
  } catch {
    // Blocked storage: the list simply starts at the top next time.
  }
};

/** Header button that opens and closes the guide. */
export const DemoGuideToggleButton = ({ open }: { readonly open: boolean }) => (
  <Button
    aria-controls={demoGuidePanelId}
    aria-expanded={open}
    aria-label="Průvodce ukázkou"
    icon={guideIcon}
    onClick={() => {
      setDemoGuideOpen(!open);
    }}
    size="sm"
    theme={open ? 'solid' : 'light'}
    variant="primary"
  >
    <span className="hidden md:inline">Průvodce ukázkou</span>
  </Button>
);

interface PanelDrag {
  readonly pointerId: number;
  readonly startWidth: number;
  readonly startX: number;
}

/** Drag handle on the panel's inner edge; desktop only. */
const ResizeHandle = () => {
  const width = useDemoGuideWidth();
  const drag = useRef<PanelDrag | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startWidth: renderedWidth(event.currentTarget, width),
      startX: event.clientX,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (active?.pointerId === event.pointerId) {
      setDemoGuideWidth(clampGuideWidth(active.startWidth + active.startX - event.clientX, sharedWidth()));
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId === event.pointerId) {
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? widthStep : -widthStep;
      setDemoGuideWidth(clampGuideWidth(renderedWidth(event.currentTarget, width) + delta, sharedWidth()));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setDemoGuideWidth(undefined);
    }
  };

  return (
    <ActionIcon
      aria-controls={demoGuidePanelId}
      aria-label="Změnit šířku průvodce. Šipky vlevo a vpravo mění šířku, Home vrátí výchozí."
      className="absolute inset-y-0 start-0 hidden h-full w-200 touch-none cursor-col-resize select-none rounded-none lg:flex"
      icon="icon-[mdi--drag-vertical]"
      onDoubleClick={() => {
        setDemoGuideWidth(undefined);
      }}
      onKeyDown={onKeyDown}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      size="sm"
      tone="neutral"
    />
  );
};

const PersonaLine = ({
  persona,
  signedIn,
}: {
  readonly persona: DemoGuidePersona | null;
  readonly signedIn: boolean;
}) =>
  persona === null ? (
    <p className="flex items-center gap-100 text-fg-secondary text-xs">
      <Icon icon="icon-[mdi--incognito]" size="sm" />
      <span>Bez přihlášení do OntOS: zákazník e-shopu, otevře se v nové kartě</span>
    </p>
  ) : (
    <div className="flex flex-wrap items-center gap-100 text-xs">
      <Icon className="text-fg-secondary" icon="icon-[mdi--account-circle-outline]" size="sm" />
      <span className="font-medium text-fg-primary">{persona.role}</span>
      <span className="break-all text-fg-secondary">{persona.email}</span>
      {signedIn ? (
        <Badge size="sm" variant="success">
          Jste přihlášeni
        </Badge>
      ) : (
        <Badge size="sm" variant="warning">
          Přihlaste se jako tato persona
        </Badge>
      )}
    </div>
  );

const StepLink = ({ step }: { readonly step: DemoGuideStep }) => {
  const { language } = useModernI18n();
  const navigate = useNavigate();
  const { target } = step;
  if (target.kind === 'external') {
    return (
      <LinkButton
        className="justify-self-start"
        href={target.url}
        icon="icon-[mdi--open-in-new]"
        rel="noreferrer"
        size="sm"
        target="_blank"
        theme="outlined"
        variant="primary"
      >
        {`Otevřít ${target.label}`}
      </LinkButton>
    );
  }
  const href = `/${language ?? 'cs'}${target.path === '/' ? '' : target.path}`;
  const open = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    // Below the desktop breakpoint the panel covers the page; close it so the screen is visible.
    if (!isDesktop()) {
      setDemoGuideOpen(false);
    }
    void navigate({ href });
  };
  return (
    <LinkButton
      className="justify-self-start"
      href={href}
      icon="icon-[mdi--arrow-right]"
      onClick={open}
      size="sm"
      theme="outlined"
      variant="primary"
    >
      Otevřít obrazovku
    </LinkButton>
  );
};

const StepCard = ({
  done,
  identityEmail,
  isNext,
  onToggle,
  step,
}: {
  readonly done: boolean;
  readonly identityEmail: string | undefined;
  readonly isNext: boolean;
  readonly onToggle: () => void;
  readonly step: DemoGuideStep;
}) => {
  const checkboxId = `demo-guide-check-${step.id}`;
  return (
    <li
      className={`grid gap-150 rounded-lg border p-200 ${isNext ? 'border-primary bg-primary-light' : 'border-border-primary bg-base'}`}
      id={`demo-guide-step-${step.id}`}
    >
      <div className="flex items-start gap-150">
        <Checkbox checked={done} className="mt-50 shrink-0" id={checkboxId} onChange={onToggle} />
        <label
          className={`min-w-0 flex-1 font-semibold text-sm ${done ? 'text-fg-secondary line-through' : 'text-fg-primary'}`}
          htmlFor={checkboxId}
        >
          {step.title}
        </label>
        {isNext ? (
          <Badge size="sm" variant="info">
            Další krok
          </Badge>
        ) : null}
      </div>
      <div className="grid gap-50 rounded-md bg-surface p-150">
        <span className="font-medium text-fg-secondary text-xs uppercase tracking-wide">Co říct</span>
        <p className="text-fg-primary text-sm">{`„${step.say}“`}</p>
      </div>
      <PersonaLine persona={step.persona} signedIn={step.persona !== null && identityEmail === step.persona.email} />
      {step.click === undefined ? null : (
        <p className="flex items-start gap-100 text-fg-secondary text-xs">
          <Icon className="shrink-0" icon="icon-[mdi--cursor-default-click-outline]" size="sm" />
          <span>
            <span className="font-medium text-fg-primary">Co kliknout: </span>
            {step.click}
          </span>
        </p>
      )}
      <StepLink step={step} />
    </li>
  );
};

export interface DemoGuidePanelProps {
  readonly guide: DemoGuide;
  /** E-mail of the signed-in account; marks steps whose persona is already signed in. */
  readonly identityEmail: string | undefined;
}

const boundaryGroups = [
  { icon: 'icon-[mdi--check-circle-outline]', key: 'live', title: 'Živě z OntOS' },
  { icon: 'icon-[mdi--theater]', key: 'simulated', title: 'Jen simulace' },
  { icon: 'icon-[mdi--progress-wrench]', key: 'unfinished', title: 'Zatím není hotové' },
] as const satisfies readonly {
  readonly icon: IconType;
  readonly key: keyof DemoGuideBoundaries;
  readonly title: string;
}[];

/** One place that says what is real, what is simulated and what is unfinished, so nothing is promised by mistake. */
const BoundariesSection = ({ boundaries }: { readonly boundaries: DemoGuideBoundaries }) => (
  <section aria-labelledby="demo-guide-boundaries" className="grid gap-150 border-border-primary border-t pt-250">
    <header className="grid gap-50">
      <h3 className="font-semibold text-fg-primary text-sm" id="demo-guide-boundaries">
        Co je živé, co simulace a co není hotové
      </h3>
      <p className="text-fg-secondary text-xs">Pro prezentujícího: tyto hranice ukázky neslibujte jinak.</p>
    </header>
    {boundaryGroups.map((group) =>
      boundaries[group.key].length === 0 ? null : (
        <div className="grid gap-50" key={group.key}>
          <p className="flex items-center gap-100 font-medium text-fg-primary text-sm">
            <Icon className="shrink-0" icon={group.icon} size="sm" />
            <span>{group.title}</span>
          </p>
          <ul className="grid list-disc gap-50 ps-250 text-fg-secondary text-xs">
            {boundaries[group.key].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ),
    )}
  </section>
);

/**
 * Non-modal guide docked to the right edge below the top bar. It is not a dialog: the page stays usable while the
 * presenter clicks along. It stacks below the ui-kit dialog layers (backdrop 10, positioner 20): a drawer or dialog
 * opened from the page covers the guide instead of hiding its own buttons under it, and the guide is back once the
 * dialog closes. Full width below the desktop breakpoint, resizable above it (width lives in the store and
 * reaches the panel through the `--demo-guide-width` variable the shell frame sets).
 */
export const DemoGuidePanel = ({ guide, identityEmail }: DemoGuidePanelProps) => {
  const doneIds = useDemoGuideProgress(guide.id);
  const summary = summarizeGuideProgress(guide, doneIds);
  const percent = summary.total === 0 ? 0 : Math.round((summary.done / summary.total) * 100);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (listRef.current !== null) {
      listRef.current.scrollTop = readScroll(guide.id);
    }
  }, [guide.id]);

  return (
    <aside
      aria-label="Průvodce ukázkou"
      className="fixed end-0 bottom-0 z-5 flex w-full flex-col border-border-primary border-s bg-base shadow-dialog-content lg:w-(--demo-guide-width)"
      id={demoGuidePanelId}
      style={{ top: 'var(--spacing-700)' }}
    >
      <ResizeHandle />
      <header className="flex items-start gap-150 border-border-primary border-b p-250 lg:ps-300">
        <span className="flex size-icon-control-lg shrink-0 items-center justify-center rounded-md bg-primary text-fg-primary">
          <Icon icon={guideIcon} size="md" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-50">
          <span className="text-fg-secondary text-xs uppercase tracking-wide">Průvodce ukázkou</span>
          <h2 className="truncate font-semibold text-fg-primary text-md">{guide.companyName}</h2>
        </div>
        <ActionIcon
          aria-label="Zavřít průvodce"
          icon="token-icon-dialog-close"
          onClick={() => {
            setDemoGuideOpen(false);
          }}
          size="md"
          tone="neutral"
        />
      </header>
      <div
        className="flex min-h-0 flex-1 flex-col gap-300 overflow-y-auto p-250 lg:ps-300"
        onScroll={(event) => {
          writeScroll(guide.id, event.currentTarget.scrollTop);
        }}
        ref={listRef}
      >
        <section aria-label="Postup ukázky" className="grid gap-150">
          <p className="text-fg-primary text-sm">{guide.intro}</p>
          <p className="flex items-start gap-100 text-fg-secondary text-xs">
            <Icon className="shrink-0" icon="icon-[mdi--key-outline]" size="sm" />
            <span>
              {`Heslo všech ukázkových účtů: ${demoPasswordHint}. Pro jinou personu použijte samostatný profil prohlížeče, nebo se odhlaste a přihlaste znovu.`}
            </span>
          </p>
          <div className="flex items-center justify-between gap-150">
            <span className="font-medium text-fg-primary text-sm">{`Hotovo ${summary.done} z ${summary.total} kroků`}</span>
            <Button
              disabled={summary.done === 0}
              icon="icon-[mdi--restart]"
              onClick={() => {
                resetDemoGuideProgress(guide.id);
              }}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              Začít znovu
            </Button>
          </div>
          <div
            aria-label="Postup ukázky"
            aria-valuemax={summary.total}
            aria-valuemin={0}
            aria-valuenow={summary.done}
            className="h-100 w-full overflow-hidden rounded-full bg-surface"
            role="progressbar"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          {summary.total > 0 && summary.nextStepId === undefined ? (
            <p className="flex items-center gap-100 text-fg-primary text-sm">
              <Icon icon="icon-[mdi--check-circle-outline]" size="sm" />
              <span>Ukázka je kompletně projitá.</span>
            </p>
          ) : null}
        </section>
        {guide.chapters.map((chapter, chapterIndex) => {
          const chapterDone = chapter.steps.filter((step) => doneIds.includes(step.id)).length;
          const headingId = `demo-guide-chapter-${chapter.id}`;
          return (
            <section aria-labelledby={headingId} className="grid gap-150" key={chapter.id}>
              <header className="grid gap-50">
                <div className="flex items-center justify-between gap-150">
                  <h3 className="font-semibold text-fg-primary text-sm" id={headingId}>
                    {`${chapterIndex + 1}. ${chapter.title}`}
                  </h3>
                  <Badge size="sm" variant={chapterDone === chapter.steps.length ? 'success' : 'outline'}>
                    {`${chapterDone}/${chapter.steps.length}`}
                  </Badge>
                </div>
                <p className="text-fg-secondary text-xs">{chapter.summary}</p>
              </header>
              <ol className="grid gap-150">
                {chapter.steps.map((step) => (
                  <StepCard
                    done={doneIds.includes(step.id)}
                    identityEmail={identityEmail}
                    isNext={step.id === summary.nextStepId}
                    key={step.id}
                    onToggle={() => {
                      setDemoGuideProgress(guide.id, toggleStep(doneIds, step.id));
                    }}
                    step={step}
                  />
                ))}
              </ol>
            </section>
          );
        })}
        {guide.boundaries === undefined ? null : <BoundariesSection boundaries={guide.boundaries} />}
      </div>
    </aside>
  );
};
