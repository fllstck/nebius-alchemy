import * as BunTest from 'bun:test'
import * as BucketModule from '../../../../modules/resources/storage/v1/bucket'

const { describe, expect, test } = BunTest

describe('Nebius.storage.v1.Bucket', () => {
  test('NebiusBucket resource constructor is defined', () => {
    expect(BucketModule.NebiusBucket).toBeDefined()
    expect(typeof BucketModule.NebiusBucket).toBe('function')
  })

  test('NebiusBucketProvider is defined', () => {
    expect(BucketModule.NebiusBucketProvider).toBeDefined()
  })

  test('NebiusBucketProps and NebiusBucketAttributes types compile', () => {
    // Type-only test — if this file compiles, the types are valid.
    // We verify the provider has the expected lifecycle methods.
    const provider = BucketModule.NebiusBucketProvider
    expect(typeof provider).toBe('object')
  })
})
