const splitLatin = /^[a-z]+(?:[ \u00a0\u3000]+[a-z]+)+$/i;
const letters = /^[a-z]+$/i;

/** Repair only an IME's segmented Latin commit, with evidence of a language
 * switch or a complete physical key trace. Deliberate spaces stay untouched. */
export function normalizeImeCommit({ text, switched, typedSpace, protectedContext, rawKeys = '' }) {
  if (protectedContext || typedSpace || !splitLatin.test(text) || text.length > 128) return text;
  const compact = text.replace(/[ \u00a0\u3000]+/g, '');
  if (!switched && (!letters.test(rawKeys) || rawKeys.toLowerCase() !== compact.toLowerCase())) return text;
  return compact;
}
