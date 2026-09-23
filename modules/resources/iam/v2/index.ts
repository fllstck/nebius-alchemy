export {
  NebiusProject as Project,
  NebiusProjectProvider as ProjectProvider,
  type NebiusProject as ProjectResource,
} from './project.ts'
// Branded ids as **values** (AGENTS.md §"Branded IDs"): `ProjectId` for a literal project id, `TenantId`
// for the tenant-scoped IAM reads, `AccessKeyId` for a key referenced from config.
export { ProjectId, TenantId, AccessKeyId } from './ids.ts'
export {
  NebiusAccessKey as AccessKey,
  NebiusAccessKeyProvider as AccessKeyProvider,
  type NebiusAccessKey as AccessKeyResource,
} from './access-key.ts'

