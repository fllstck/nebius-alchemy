/**
 * M0 spike — simulates `host-identity.ts` (deploy-time provisioning module).
 * Statically imports @grpc/grpc-js, the Node-only dependency the Worker
 * bundle must never receive.
 */
import * as grpc from '@grpc/grpc-js'

export const makeIdentity = (): string => {
  // eslint-disable-next-line no-new
  new grpc.Client('localhost:443', grpc.credentials.createInsecure())
  return 'identity'
}
