function databaseIndex(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 2_147_483_647 ? index : null;
}

// History and older restored query tabs have a database but no redisDb. Keep
// their destination, and use the profile only when neither tab field is valid.
export function resolveRedisDatabase(tab, profile) {
  for (const value of [tab?.redisDb, tab?.database, profile?.redisDb, profile?.database]) {
    const index = databaseIndex(value);
    if (index !== null) return index;
  }
  return 0;
}
