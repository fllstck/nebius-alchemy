/**
 * Mutation testing — scoped to the repo's *pure* logic modules.
 *
 * Why this scope: mutation testing is worth its cost where line coverage is high
 * but assertion strength is unknown — `utilities.ts` (the `specDeepEqual` workaround
 * and attribute plumbing), `factory.ts` (CRUD/replace helpers), `validation.ts` (the
 * field filters) and `effect-utils.ts` are all ~100 % line-covered, so a surviving
 * mutant there is a genuine oracle gap. The provider `reconcile` bodies are
 * deliberately excluded: their branches are 15–55 % covered, so a run would mostly
 * re-report "unexecuted", which `bun test --coverage` already says for free.
 * `schemas/**` is excluded too — generated code would drown the report in
 * equivalent mutants.
 *
 * Run with `bun run mutation` (or `bun run mutation -- --dryRunOnly` to check the
 * harness without mutating).
 */
export default {
  // The bun runner is outside the `@stryker-mutator` scope, so it is NOT picked up by
  // Stryker's default `@stryker-mutator/*` plugin glob and must be listed explicitly
  // (otherwise the `bun:` options below are reported as unknown options).
  plugins: ['@hughescr/stryker-bun-runner'],
  testRunner: 'bun',
  coverageAnalysis: 'perTest',
  // Stryker's type-stripping preprocessor drives the TypeScript compiler API, and this
  // repo is on `typescript@7` (tsgo), where `parseConfigFileTextToJson` no longer exists
  // — it dies with "ts.parseConfigFileTextToJson is not a function". It is also
  // unnecessary: Bun strips types natively.
  disableTypeChecks: false,
  mutate: [
    'modules/resources/utilities.ts',
    'modules/resources/factory.ts',
    'modules/resources/validation.ts',
    'modules/effect-utils.ts',
    // The gRPC layer every provider sits on: code mapping, retry policy, operation polling,
    // pagination. Pure decision logic, so a surviving mutant here is a real oracle gap.
    'modules/api-client/grpc-utils.ts',
  ],
  // `node_modules` is always ignored by Stryker (the sandbox resolves it by walking
  // up to the real install); `dist/` and `repos/` are 150 MB of code no test reads.
  ignorePatterns: ['dist', 'repos', '.alchemy', 'spikes', 'docs'],
  reporters: ['clear-text', 'json'],
  thresholds: { high: 90, low: 80, break: null },
  concurrency: 4,
  // Work around Stryker's `TSConfigPreprocessor` being unconditional in a sandboxed run:
  // it dynamically imports `typescript` and calls `ts.parseConfigFileTextToJson`, which
  // TypeScript 7 (tsgo) does not export — the run dies before the initial test run. It
  // only touches the file if that exact path is present in the sandbox, so pointing it at
  // a path that does not exist makes it a no-op. Nothing else reads this option (the
  // TypeScript checker is not enabled), and the real `tsconfig.json` still ships into the
  // sandbox untouched for Bun's own path resolution.
  tsconfigFile: '<not-a-file>.tsconfig.json',
  // Per-`bun test` child (each mutant spawns a fresh process) and per test.
  bun: { timeout: 30_000 },
}
