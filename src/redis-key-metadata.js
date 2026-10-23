// Keep SCAN names compatible with existing consumers; type metadata is scoped
// to the same connection/DB/page and never inferred from a key's spelling.
export function mergeRedisKeyPage(current, response, reset = false) {
  const incoming = (response.keys || []).filter(key => typeof key === 'string');
  const keys = [...new Set([...(reset ? [] : current.keys || []), ...incoming])];
  const keyTypes = new Map(reset ? [] : current.keyTypes instanceof Map ? current.keyTypes : []);
  const types = response.keyTypes && typeof response.keyTypes === 'object' ? response.keyTypes : {};
  for (const key of incoming) {
    keyTypes.delete(key);
    if (Object.hasOwn(types, key) && typeof types[key] === 'string' && types[key]) keyTypes.set(key, types[key]);
  }
  return { keys, keyTypes };
}

export function redisPageKeyType(page, key) {
  if (page?.keyTypes instanceof Map) return page.keyTypes.get(key);
  return page?.keyTypes && Object.hasOwn(page.keyTypes, key) ? page.keyTypes[key] : undefined;
}
