export interface PropertyUnitCardProps {
  floorLabel?: string;
  occupancyState?: 'available' | 'occupied' | 'reserved' | 'unknown';
  ownerModuleId?: 'property.registry';
  rendersFrom?: 'property.registry';
  title?: string;
  unitId?: string;
}

const occupancyLabels: Record<NonNullable<PropertyUnitCardProps['occupancyState']>, string> = {
  available: 'Available',
  occupied: 'Occupied',
  reserved: 'Reserved',
  unknown: 'Unknown',
};

export const PropertyUnitCard = ({
  floorLabel = 'Floor not assigned',
  occupancyState = 'unknown',
  ownerModuleId = 'property.registry',
  rendersFrom = 'property.registry',
  title = 'Property unit placeholder',
  unitId = 'property.unit.fixture',
}: PropertyUnitCardProps) => (
  <article
    aria-label={`${title} (${unitId})`}
    className="propertyregistry:rounded-lg propertyregistry:border propertyregistry:border-stone-900/10 propertyregistry:bg-white propertyregistry:p-4 propertyregistry:text-stone-950 propertyregistry:shadow-sm"
    data-ontos-component="PropertyUnitCard"
    data-ontos-owned-by={ownerModuleId}
    data-ontos-renders-from={rendersFrom}
    data-ontos-resource="property.unit"
  >
    <div className="propertyregistry:flex propertyregistry:items-start propertyregistry:justify-between propertyregistry:gap-3">
      <div>
        <p className="propertyregistry:text-xs propertyregistry:font-bold propertyregistry:uppercase propertyregistry:text-stone-500">
          property.unit
        </p>
        <h2 className="propertyregistry:mt-1 propertyregistry:text-lg propertyregistry:font-black">
          {title}
        </h2>
      </div>
      <span className="propertyregistry:rounded-full propertyregistry:bg-emerald-50 propertyregistry:px-3 propertyregistry:py-1 propertyregistry:text-xs propertyregistry:font-bold propertyregistry:text-emerald-700">
        {occupancyLabels[occupancyState]}
      </span>
    </div>
    <dl className="propertyregistry:mt-4 propertyregistry:grid propertyregistry:grid-cols-2 propertyregistry:gap-3 propertyregistry:text-sm">
      <div>
        <dt className="propertyregistry:font-bold propertyregistry:text-stone-500">Unit ID</dt>
        <dd className="propertyregistry:mt-1 propertyregistry:text-stone-800">{unitId}</dd>
      </div>
      <div>
        <dt className="propertyregistry:font-bold propertyregistry:text-stone-500">Floor</dt>
        <dd className="propertyregistry:mt-1 propertyregistry:text-stone-800">{floorLabel}</dd>
      </div>
    </dl>
  </article>
);

export default PropertyUnitCard;
