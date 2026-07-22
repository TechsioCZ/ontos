// @effect-diagnostics globalDate:off
export interface CreatedTimePresentationProps {
  readonly detail: boolean;
  readonly instant: string;
  readonly locale: string;
  readonly timeZone: string;
}

export const CreatedTimePresentation = ({
  detail,
  instant,
  locale,
  timeZone,
}: CreatedTimePresentationProps) => (
  <time dateTime={instant}>
    {new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: detail ? 'medium' : 'short',
      timeZone,
    }).format(new Date(instant))}
  </time>
);

// Both system-time datatypes share one absolute-instant presentation contract.
export const LastEditedTimePresentation = CreatedTimePresentation;

export interface CreatedByPresentationProps {
  readonly displayName: string;
  readonly inactive: boolean;
  readonly inactiveLabel: string;
}

export const CreatedByPresentation = ({
  displayName,
  inactive,
  inactiveLabel,
}: CreatedByPresentationProps) => (
  <span>
    {displayName}
    {inactive ? ` (${inactiveLabel})` : null}
  </span>
);

// Both Principal-backed intrinsic datatypes share current-name and inactive presentation.
export const LastEditedByPresentation = CreatedByPresentation;
