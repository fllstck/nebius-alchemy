import { describe, expect, test } from 'bun:test'
import { fakeChannel } from './channel'

describe('fakeChannel', () => {
  test('is a plain structural mock, not a real grpc.Channel', () => {
    const channel = fakeChannel()
    expect(channel).toBeTypeOf('object')
    // A real channel would be an instanceof grpc.Channel; the fake must not be.
    expect(channel.constructor.name).not.toBe('ChannelImplementation')
  })

  test('returns a fresh instance per call (no shared state)', () => {
    expect(fakeChannel()).not.toBe(fakeChannel())
  })

  test('stubs throw a descriptive error if invoked', () => {
    const channel = fakeChannel()
    // All stubbed methods fail loudly — real channel behavior is unavailable
    // in unit tests, and silent misbehavior would mask wiring bugs.
    for (const method of [
      'getConnectivityState',
      'watchConnectivityState',
      'createCall',
      'getTarget',
      'getChannelzRef',
      'addTraceEvent',
      'close',
    ] as const) {
      const invoke = (channel as unknown as Record<string, () => unknown>)[method]
      expect(invoke).toBeTypeOf('function')
      expect(() => invoke!()).toThrow(/fakeChannel\./)
    }
  })
})
