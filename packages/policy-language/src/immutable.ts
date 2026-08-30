function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** Freeze the acyclic records and arrays constructed by this package. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (!isObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}
