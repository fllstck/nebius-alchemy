import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

// NOTE: Image creation requires a source disk or snapshot (spec.source oneof).
// A full integration test would need to create a disk first, snapshot it,
// then create the image — too complex for a single lifecycle test.
// This test is skipped until a simpler source mechanism is available.
test.provider.skipIf(true)('Nebius.compute.v1.Image lifecycle', (_stack) =>
  Effect.gen(function* () {
    // placeholder
  }),
  { timeout: 120_000 },
)
