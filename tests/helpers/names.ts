/**
 * Unique resource-name generation for integration tests.
 *
 * `Date.now()`-based names collide when two runs share a millisecond, and
 * against resources leaked by prior failed runs — both cause flaky
 * ALREADY_EXISTS failures. Use a random suffix instead.
 *
 * Nebius resource names must be DNS-compliant (lowercase, `-`/`.` allowed)
 * and bounded — keep suffixes short. The prefix is the caller's
 * responsibility to keep within limits.
 */
export const uniqueName = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`
