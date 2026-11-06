/** Static N1 navigation illustrations, separate from owner category/product media.
 * Historical N1 src/data/header/index.ts selects these exact five assets for
 * Pánské. Only audited legacy IDs match; names, hierarchy and hrefs stay native.
 */
export const navigationArtwork: ReadonlyMap<
  string,
  { readonly height: number; readonly src: string; readonly width: number }
> = new Map([
  [
    "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:category:3",
    { height: 100, src: "/navigation/panske-obleceni.webp", width: 200 },
  ],
  [
    "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:category:33",
    { height: 100, src: "/navigation/panske-cyklo.webp", width: 200 },
  ],
  [
    "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:category:78",
    { height: 100, src: "/navigation/panske-moto.webp", width: 200 },
  ],
  [
    "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:category:102",
    { height: 100, src: "/navigation/panske-snb-skt.webp", width: 100 },
  ],
  [
    "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:category:119",
    { height: 100, src: "/navigation/panske-ski.webp", width: 100 },
  ],
]);
