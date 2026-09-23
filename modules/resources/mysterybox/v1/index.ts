export {
  NebiusSecret as Secret,
  NebiusSecretProvider as SecretProvider,
  type NebiusSecret as SecretResource,
} from './secret.ts'
export {
  NebiusSecretVersion as SecretVersion,
  NebiusSecretVersionProvider as SecretVersionProvider,
  type NebiusSecretVersion as SecretVersionResource,
} from './secret-version.ts'
// Branded ids as **values** (AGENTS.md §"Branded IDs"), for the common `secretId`-from-config case.
export { SecretId, SecretVersionId } from './ids.ts'
