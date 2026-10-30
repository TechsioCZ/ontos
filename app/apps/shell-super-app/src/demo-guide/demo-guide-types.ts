import { Schema } from 'effect';

/**
 * In-app sales demo guide ("Průvodce ukázkou"). Static, typed content per demo company; the shell picks the guide
 * of the currently selected legal entity, so a guide never shows another company's screens.
 */

/** Demo company guides; one per legal entity. */
export const DemoGuideIdSchema = Schema.Literals(['akros', 'hanak', 'obchod', 'siampark']);
export type DemoGuideId = typeof DemoGuideIdSchema.Type;

/** Public demo account the presenter signs in with for a step; never an authentication default. */
export interface DemoGuidePersona {
  /** Sign-in e-mail, e.g. `management@najempark.demo`. */
  readonly email: string;
  /** Short Czech role label, e.g. `Vedení nemovitostí`. */
  readonly role: string;
}

/** Where the step's button leads. */
export type DemoGuideTarget =
  | {
      readonly kind: 'app';
      /** Staff-app path WITHOUT the language prefix; starts with `/`, may contain `?query`. Example: `/sprava/ke-schvaleni`. */
      readonly path: string;
    }
  | {
      readonly kind: 'external';
      /** Czech name of the destination used in the button text, e.g. `e-shop firmy`. */
      readonly label: string;
      /** Absolute URL opened in a new tab, e.g. a connected storefront `http://localhost:3070/kosik`. */
      readonly url: string;
    };

export interface DemoGuideStep {
  /** "Co kliknout": optional short Czech click path. */
  readonly click?: string;
  /** Unique within its guide, kebab-case, prefixed with the guide id, e.g. `siampark-r101`. */
  readonly id: string;
  /** Account to be signed in as; `null` = anonymous storefront customer (no staff sign-in). */
  readonly persona: DemoGuidePersona | null;
  /** Quoted talking point: 1–2 Czech sentences, without surrounding quotation marks. */
  readonly say: string;
  readonly target: DemoGuideTarget;
  readonly title: string;
}

export interface DemoGuideChapter {
  /** Unique within its guide, kebab-case, e.g. `ai`. */
  readonly id: string;
  readonly steps: readonly DemoGuideStep[];
  /** One Czech sentence describing the chapter. */
  readonly summary: string;
  readonly title: string;
}

/** What runs against OntOS, how operations work and which capabilities are included. */
export interface DemoGuideBoundaries {
  /** Runs for real against OntOS (Czech sentences). */
  readonly live: readonly string[];
  /** Operational details, including steps handled outside OntOS. */
  readonly operations: readonly string[];
  /** Scope of available capabilities. */
  readonly scope: readonly string[];
}

export interface DemoGuide {
  /** Optional operational overview shown below the steps. */
  readonly boundaries?: DemoGuideBoundaries;
  readonly chapters: readonly DemoGuideChapter[];
  readonly companyName: string;
  readonly id: DemoGuideId;
  /** One or two Czech sentences shown at the top of the guide and on the Home card. */
  readonly intro: string;
  /** Exact legal entity id the guide belongs to. */
  readonly legalEntityId: string;
}
