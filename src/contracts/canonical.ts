/** node-stable-json-v1: UTF-16 key order, JSON number spelling, no Unicode normalization.
 * This shared module deliberately has no Node imports or environment/file access.
 */

function reject(path: string, reason: string): never {
  throw new TypeError(`Invalid JSON at ${path}: ${reason}`);
}

function assertUnicode(text: string, path: string): void {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject(path, 'unpaired Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      reject(path, 'unpaired Unicode surrogate');
    }
  }
}

/** Serialize strict finite JSON without omitting or coercing any field. */
export function canonicalizeArtifact(value: unknown): string {
  const ancestors = new Set<object>();

  function serialize(current: unknown, path: string): string {
    if (current === null) return 'null';
    if (typeof current === 'string') {
      assertUnicode(current, path);
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) reject(path, 'number must be finite');
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') reject(path, `${typeof current} is not JSON`);
    if (ancestors.has(current)) reject(path, 'cyclic reference');

    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      reject(path, 'only plain objects and arrays are JSON');

    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key === 'symbol')) reject(path, 'symbol keys are not JSON');
    const descriptors = Object.getOwnPropertyDescriptors(current);
    ancestors.add(current);
    try {
      if (array) {
        const values = current as unknown[];
        if (keys.length !== values.length + 1) reject(path, 'sparse array or extra array properties');
        const items: string[] = [];
        for (let index = 0; index < values.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            reject(`${path}[${index}]`, 'array slots must be enumerable data properties');
          items.push(serialize(descriptor.value, `${path}[${index}]`));
        }
        return `[${items.join(',')}]`;
      }

      const entries: string[] = [];
      for (const key of (keys as string[]).sort()) {
        assertUnicode(key, path);
        const descriptor = descriptors[key];
        if (!('value' in descriptor) || !descriptor.enumerable)
          reject(path, 'object fields must be enumerable data properties');
        entries.push(`${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`)}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return serialize(value, '$');
}

/** Zero-based, half-open Unicode code-point slice; invalid ranges never clip. */
export function sliceCodePoints(text: string, start: number, end: number): string {
  if (typeof text !== 'string') reject('$text', 'expected string');
  assertUnicode(text, '$text');
  const points = Array.from(text);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || end > points.length)
    throw new RangeError('Code-point range must be safe integers with 0 <= start <= end <= length.');
  return points.slice(start, end).join('');
}
