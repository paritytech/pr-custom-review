import assert from "assert";

export const envVar = (name: string) => {
  const val = process.env[name];
  if (typeof val !== "string") {
    throw new Error(`${name} was not found in the environment variables`);
  }
  return val;
};

export const envNumberVar = (name: string) => {
  const val = process.env[name];
  assert(val, `${name} was not found in the environment variables`);
  const valNumber = parseInt(val);
  assert(!isNaN(valNumber), `${name} is not a number`);
  return valNumber;
};

export const delayMilliseconds = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration));

export class Ok<T> {
  constructor(public value: T) {}
}
export class Err<T> {
  constructor(public value: T) {}
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
const normalizers = {
  symbol: (value: any) => value.toString(),
  bigint: (value: any) => value.toString(),
  undefined: () => undefined,
  function: () => undefined,
  boolean: (value: any) => value,
  number: (value: any) => value,
  string: (value: any) => value,
  object: (value: any, previousObjects: unknown[] = []) => {
    if (value === null) {
      return;
    }

    previousObjects = previousObjects.concat([value]);

    const isArray = Array.isArray(value);
    const isIterable = !isArray && Symbol.iterator in value;
    const objAsArray = isArray ? value : isIterable ? Array.from(value as Iterable<unknown>) : undefined;

    if (objAsArray === undefined && !(value instanceof Error)) {
      const asString =
        typeof value.toString === "function" && value.toString.length === 0 ? value.toString() : undefined;
      if (typeof asString === "string" && asString !== "[object Object]") {
        return asString;
      }
    }

    const { container, output } = (() => {
      if (isIterable) {
        const iteratorContainer = { type: value.constructor.name, items: [] };
        return { container: iteratorContainer, output: iteratorContainer.items };
      }
      const outputObj = objAsArray === undefined ? {} : [];
      return { container: outputObj, output: outputObj };
    })();

    const sourceObj = objAsArray ?? value;
    for (const key of Object.getOwnPropertyNames(sourceObj)) {
      setNormalizedKeyValue(sourceObj, output, key, previousObjects);
    }

    if (Object.keys(output).length > 0) {
      return container;
    }
  },
};

const setNormalizedKeyValue = (source: any, output: any, key: any, previousObjects: unknown[]) => {
  if (previousObjects.indexOf(source[key]) !== -1) {
    return "[Circular]";
  }

  const value = normalizeValue(source[key], previousObjects);
  if (value === undefined) {
    return;
  }

  output[key] = value;
};

export const normalizeValue = (value: unknown, previousObjects: unknown[] = []): unknown =>
  normalizers[typeof value](value, previousObjects);
