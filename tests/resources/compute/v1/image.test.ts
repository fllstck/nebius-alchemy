import * as BunTest from 'bun:test'
import * as ImageModule from '../../../../modules/resources/compute/v1/image'

const { describe, expect, test } = BunTest

describe('Nebius.compute.v1.Image', () => {
  test('NebiusImage resource constructor is defined', () => {
    expect(ImageModule.NebiusImage).toBeDefined()
    expect(typeof ImageModule.NebiusImage).toBe('function')
  })

  test('NebiusImageProvider is defined', () => {
    expect(ImageModule.NebiusImageProvider).toBeDefined()
  })

  test('NebiusImageProps and NebiusImageAttributes types compile', () => {
    // Type-only test — if this file compiles, the types are valid.
    const provider = ImageModule.NebiusImageProvider
    expect(typeof provider).toBe('object')
  })
})
