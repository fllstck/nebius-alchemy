/**
 * M0 spike — the NAIVE control case: static import of the gRPC module.
 * Should show grpc in the bundle (or fail to build).
 */
import { makeIdentity } from './fake-identity.ts'

export const provisionStatic = (): string => makeIdentity()
