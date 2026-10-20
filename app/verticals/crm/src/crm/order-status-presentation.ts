// Presentation only: source values, report meanings and import decisions remain unchanged.
const labels: ReadonlyMap<string, string> = new Map([
  ['nova', 'Nová'],
  ['prijata', 'Přijatá'],
  ['prijato', 'Přijato'],
  ['v reseni', 'V řešení'],
  ['zaplacena', 'Zaplacená'],
  ['uhrazena', 'Uhrazená'],
  ['uhrazeno', 'Uhrazeno'],
  ['odeslana', 'Odeslaná'],
  ['dorucena', 'Doručená'],
  ['dodana', 'Dodaná'],
  ['vyrizena', 'Vyřízená'],
  ['vyrizeno', 'Vyřízeno'],
  ['dokoncena', 'Dokončená'],
  ['stornovana', 'Stornovaná'],
  ['stornovano', 'Stornováno'],
  ['storno', 'Storno'],
  ['zrusena', 'Zrušená'],
]);

/** Restore Czech spelling for known source labels; never invent a meaning for an unknown status. */
export const orderStatusLabel = (raw: string): string => {
  const key = raw
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
  return labels.get(key) ?? raw;
};

/** Only the system-generated status reference is localized, not arbitrary quoted customer/audit text. */
export const statusReviewReasonLabel = (reason: string): string =>
  reason.replace(
    /^(Událost je starší než poslední známý stav )„([^“]+)“/u,
    (_match, prefix: string, status: string) => `${prefix}„${orderStatusLabel(status)}“`,
  );
