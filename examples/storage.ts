import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Nebius from '@fllstck/nebius-alchemy'

export interface StackOutput {
  bucketId: string
  bucketName: string
  state: string
}

export default Alchemy.Stack(
  'Storage',
  { providers: Nebius.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* Nebius.storage.Bucket('ExampleBucket')

    return {
      bucketId: bucket.id,
      bucketName: bucket.name,
      state: bucket.state,
    }
  }),
)
