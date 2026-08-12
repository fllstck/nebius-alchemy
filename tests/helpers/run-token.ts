/**
 * Per-process run token for deterministic resource names that are UNIQUE PER
 * PROJECT (e.g. managed-disk names — the API rejects a duplicate name with
 * ALREADY_EXISTS).
 *
 * A crashed/interrupted test run leaves its managed disk orphaned (the delete
 * only finishes when the instance does). A fixed name like `boot-disk` then
 * collides on the next run and blocks it until the orphan's delete completes.
 * Deriving the name from a per-process random token gives every run a fresh
 * name — the orphan never collides. (Within one run the name is constant, so
 * create/reconcile/update stay consistent; tests deploy once per run.)
 */
export const runToken = (): string => Math.random().toString(36).slice(2, 10)

/** `boot-disk` → `boot-disk-<token>` — safe for one instance per run. */
export const runDiskName = (base: string): string => `${base}-${runToken()}`
