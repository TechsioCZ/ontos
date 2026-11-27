// Portfolio of properties, and one opened property whose unit navigation sits beside its detail.
// Presentation only: the parent owns records, routing, permissions and the real forms.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { TabsTemplate } from '@techsio/ui-kit/templates/tabs';
import type { ReactNode } from 'react';

export interface PropertyNavigationItem {
  readonly address: string;
  readonly archived: boolean;
  readonly code: string;
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string;
  readonly unitCount: number;
}
export interface UnitNavigationItem {
  readonly archived: boolean;
  readonly availabilityLabel: string;
  readonly code: string;
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string;
}
export interface PropertyWorkspaceTab {
  readonly content: ReactNode;
  readonly label: string;
  readonly value: string;
}
export type PropertyWorkspaceTranslate = (key: string, values?: Record<string, string | number>) => string;
export interface PropertyWorkspaceProps {
  readonly actions: ReactNode;
  readonly activeTab: string;
  readonly busy: boolean;
  readonly canCreateUnit: boolean;
  readonly details: ReactNode;
  readonly editor: ReactNode;
  readonly filters: ReactNode;
  readonly messages: ReactNode;
  readonly onCreateProperty: () => void;
  readonly onCreateUnit: () => void;
  /** No id opens the portfolio again. */
  readonly onSelectResource: (id?: string) => void;
  readonly onSelectTab: (value: string) => void;
  readonly properties: readonly PropertyNavigationItem[];
  readonly property?: PropertyNavigationItem | undefined;
  readonly t: PropertyWorkspaceTranslate;
  readonly tabs: readonly PropertyWorkspaceTab[];
  readonly unit?: UnitNavigationItem | undefined;
  readonly units: readonly UnitNavigationItem[];
}

const panelClass = 'min-w-0 space-y-250 rounded-lg border border-border-primary p-300';
const stackClass = 'flex min-w-0 flex-col gap-4';
const rowClass = 'flex flex-wrap items-center gap-3';
const badgeRowClass = 'flex flex-wrap items-center gap-2';
const unitRowClass = 'flex flex-col gap-1';
const cardsClass = 'grid gap-4 md:grid-cols-2 2xl:grid-cols-3';
const workspaceClass = 'grid items-start gap-6 propertyportfolio:lg:grid-cols-[21rem_minmax(0,1fr)]';
const branchClass = 'border-s border-border-primary/60 ms-4 flex flex-col gap-2 ps-4';
const detailClass = 'min-w-0 space-y-4';
const titleClass = 'text-lg';
const groupLabelClass = 'text-sm font-semibold';
const mutedClass = 'text-sm text-fg-secondary';
const metaClass = 'text-xs text-fg-secondary';

/** Lifecycle and archive badges of one record, exactly as the parent labelled them. */
const StateBadges = ({
  archived,
  stateLabel,
  t,
}: {
  readonly archived: boolean;
  readonly stateLabel: string;
  readonly t: PropertyWorkspaceTranslate;
}) => (
  <span className={badgeRowClass}>
    <Badge appearance="outline" severity="neutral" size="sm">
      {stateLabel}
    </Badge>
    {archived && (
      <Badge severity="secondary" size="sm">
        {t('archived')}
      </Badge>
    )}
  </span>
);

/** State and today's availability of one unit, as the parent labelled them. */
const unitMeta = (item: UnitNavigationItem) =>
  [item.stateLabel, item.availabilityLabel].filter((part) => part !== '').join(' · ');

/** The portfolio: every property as a card whose name opens it. */
const PortfolioCards = ({
  onSelectResource,
  properties,
  t,
}: {
  readonly onSelectResource: (id: string | undefined) => void;
  readonly properties: readonly PropertyNavigationItem[];
  readonly t: PropertyWorkspaceTranslate;
}) =>
  properties.length === 0 ? (
    <p className={mutedClass}>{t('emptyProperties')}</p>
  ) : (
    <div className={cardsClass}>
      {properties.map((item) => (
        <article className={panelClass} key={item.id}>
          <div className={`${rowClass} propertyportfolio:justify-between`}>
            <span className="font-semibold">{item.code}</span>
            <StateBadges archived={item.archived} stateLabel={item.stateLabel} t={t} />
          </div>
          <h2 className={titleClass}>
            <Button className="font-semibold" onClick={() => onSelectResource(item.id)} size="current" unstyled>
              {item.name}
            </Button>
          </h2>
          <p className={mutedClass}>{item.address}</p>
          <p className={mutedClass}>{t('unitCount', { count: item.unitCount })}</p>
        </article>
      ))}
    </div>
  );

export const PropertyWorkspace = ({
  actions,
  activeTab,
  busy,
  canCreateUnit,
  details,
  editor,
  filters,
  messages,
  onCreateProperty,
  onCreateUnit,
  onSelectResource,
  onSelectTab,
  properties,
  property,
  t,
  tabs,
  unit,
  units,
}: PropertyWorkspaceProps) => {
  const propertySelected = unit === undefined;
  return (
    <section aria-label={t('properties')} className={stackClass}>
      {messages}
      <div className={rowClass}>
        {property !== undefined && (
          <Button appearance="ghost" onClick={() => onSelectResource()} severity="secondary" size="sm">
            ← {t('backToPortfolio')}
          </Button>
        )}
        <div className={`${rowClass} propertyportfolio:ms-auto`}>
          {filters}
          {property === undefined && (
            <Button appearance="outline" disabled={busy} onClick={onCreateProperty} severity="primary" size="sm">
              {t('addProperty')}
            </Button>
          )}
        </div>
      </div>
      {property === undefined ? (
        <PortfolioCards onSelectResource={onSelectResource} properties={properties} t={t} />
      ) : (
        <div className={workspaceClass}>
          <nav aria-label={t('propertyHierarchy')} className={panelClass}>
            <Button
              appearance={propertySelected ? 'solid' : 'ghost'}
              aria-current={propertySelected ? 'page' : undefined}
              block
              onClick={() => onSelectResource(property.id)}
              severity={propertySelected ? 'primary' : 'secondary'}
              size="sm"
            >
              {property.code} · {property.name}
            </Button>
            <p className={mutedClass}>{property.address}</p>
            <StateBadges archived={property.archived} stateLabel={property.stateLabel} t={t} />
            <div>
              <p className={groupLabelClass}>
                {t('units')} ({units.length})
              </p>
              <div className={branchClass}>
                {units.map((item) => {
                  const selected = item.id === unit?.id;
                  const meta = unitMeta(item);
                  return (
                    <div className={unitRowClass} key={item.id}>
                      <Button
                        appearance={selected ? 'solid' : 'ghost'}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => onSelectResource(item.id)}
                        severity={selected ? 'primary' : 'secondary'}
                        size="sm"
                      >
                        {item.code} · {item.name}
                      </Button>
                      {meta !== '' && <span className={metaClass}>{meta}</span>}
                    </div>
                  );
                })}
                {units.length === 0 && <p className={mutedClass}>{t('noUnits')}</p>}
                {canCreateUnit && (
                  <Button appearance="ghost" disabled={busy} onClick={onCreateUnit} severity="primary" size="sm">
                    {t('addUnit')}
                  </Button>
                )}
              </div>
            </div>
          </nav>
          <div className={detailClass}>
            {details}
            {actions}
            <TabsTemplate appearance="solid" items={[...tabs]} onValueChange={onSelectTab} value={activeTab} />
          </div>
        </div>
      )}
      {editor}
    </section>
  );
};
