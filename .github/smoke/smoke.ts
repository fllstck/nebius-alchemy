// Consumer smoke fixture — mirrors the README quick-start verbatim.
// Compiled by the `smoke-test` CI job against the packed tarball in a
// throwaway project; catches missing `files:` entries, exports-map
// breakage, and peer-version incompatibilities before release.
import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export default Alchemy.Stack(
  'Storage',
  {
    providers: Nebius.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('MyBucket')
    return { bucketId: bucket.id, bucketName: bucket.name }
  }),
)
