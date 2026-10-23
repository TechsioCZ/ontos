/**
 * In-app sales demo guide ("Průvodce ukázkou"). Static, typed content per demo company; the shell picks the guide
 * of the currently selected legal entity, so a guide never shows another company's screens.
 */

/** Demo company guides; one per legal entity. */
export type DemoGuideId = 'akros' | 'hanak' | 'obchod' | 'siampark';

/** Account the presenter signs in with for a step. Every demo account uses `demoPasswordHint`. */
export interface DemoGuidePersona {
  /** Sign-in e-mail, e.g. `management@siampark.demo`. */
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
      /** Absolute URL opened in a new tab, e.g. a connected storefront `http://localhost:3070/kosik`. */
      readonly url: string;
      /** Czech name of the destination used in the button text, e.g. `e-shop firmy`. */
      readonly label: string;
    };

export interface DemoGuideStep {
  /** Unique within its guide, kebab-case, prefixed with the guide id, e.g. `siampark-r101`. */
  readonly id: string;
  readonly title: string;
  /** Quoted talking point: 1–2 Czech sentences, without surrounding quotation marks. */
  readonly say: string;
  /** Account to be signed in as; `null` = anonymous storefront customer (no staff sign-in). */
  readonly persona: DemoGuidePersona | null;
  readonly target: DemoGuideTarget;
  /** "Co kliknout": optional short Czech click path. */
  readonly click?: string;
}

export interface DemoGuideChapter {
  /** Unique within its guide, kebab-case, e.g. `ai`. */
  readonly id: string;
  readonly title: string;
  /** One Czech sentence describing the chapter. */
  readonly summary: string;
  readonly steps: readonly DemoGuideStep[];
}

/** One honest statement of what the demo really does, what it only simulates and what is not finished yet. */
export interface DemoGuideBoundaries {
  /** Runs for real against OntOS (Czech sentences). */
  readonly live: readonly string[];
  /** Shown in the demo but deliberately simulated; nothing happens outside the demo. */
  readonly simulated: readonly string[];
  /** Known unfinished parts the presenter should not promise. */
  readonly unfinished: readonly string[];
}

export interface DemoGuide {
  readonly id: DemoGuideId;
  /** Exact legal entity id the guide belongs to. */
  readonly legalEntityId: string;
  readonly companyName: string;
  /** One or two Czech sentences shown at the top of the guide and on the Home card. */
  readonly intro: string;
  readonly chapters: readonly DemoGuideChapter[];
  /** Optional consolidated "živé / simulace / není hotové" section shown below the steps. */
  readonly boundaries?: DemoGuideBoundaries;
}

/** Shared password of every demo account (local demo only). */
export const demoPasswordHint = 'password1234';
