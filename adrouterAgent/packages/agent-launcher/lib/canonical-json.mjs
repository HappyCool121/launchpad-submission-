const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const assertUnicodeScalarString = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('Canonical JSON rejects lone UTF-16 surrogates.');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Canonical JSON rejects lone UTF-16 surrogates.');
    }
  }
};

const serialize = (value) => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry)).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('Canonical JSON accepts only JSON values.');

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => {
      assertUnicodeScalarString(key);
      if (value[key] === undefined) {
        throw new TypeError('Canonical JSON rejects undefined object values.');
      }
      return `${JSON.stringify(key)}:${serialize(value[key])}`;
    })
    .join(',')}}`;
};

// RFC 8785 JSON Canonicalization Scheme using ECMAScript number/string serialization.
export const canonicalJson = (value) => serialize(value);
