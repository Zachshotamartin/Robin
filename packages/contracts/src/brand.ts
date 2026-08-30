declare const brand: unique symbol;

/**
 * Nominal typing helper. A branded value is structurally its base type but
 * cannot be assigned across brands, which keeps `RunId`, `ActionId`, and the
 * other identifier kinds from being interchangeable strings.
 */
export type Brand<T, Name extends string> = T & {
  readonly [brand]: Name;
};
