/**
 * Escapes a string so it can be used literally inside a RegExp.
 *
 * Search boxes feed user input straight into a Mongo regex. Unescaped, a dot
 * matches everything, and a pattern that backtracks catastrophically can pin
 * the CPU for the life of the request — a denial of service from a search box.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
