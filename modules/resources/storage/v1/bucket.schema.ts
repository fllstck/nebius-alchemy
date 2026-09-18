import * as Schema from 'effect/Schema'

import * as Validation from '../../validation.ts'
import * as Ids from './ids.ts'
import * as IamIds from '../../iam/v1/ids.ts'
import * as IamV2Ids from '../../iam/v2/ids.ts'

// ---------------------------------------------------------------------------
// Domain-specific validations (TypeScript can't catch these)
// ---------------------------------------------------------------------------

/** CORS maxAgeSeconds must be non-negative when set. */
const corsRuleValid = Schema.makeFilter((rule: Record<string, unknown>) => {
  const issues: Array<Schema.FilterIssue> = []

  if (rule.maxAgeSeconds !== undefined && typeof rule.maxAgeSeconds === 'number' && rule.maxAgeSeconds < 0) {
    issues.push({ path: ['maxAgeSeconds'], issue: `maxAgeSeconds must be >= 0, got ${rule.maxAgeSeconds}` })
  }

  const origins = rule.allowedOrigins as string[] | undefined
  if (origins) {
    for (const [i, origin] of origins.entries()) {
      if (origin !== '*' && !isValidOrigin(origin)) {
        issues.push({ path: ['allowedOrigins', i], issue: `Invalid origin: "${origin}"` })
      }
    }
  }

  return issues
})

/** Lifecycle rule: storageClass is required when action type is SetStorageClass. */
const lifecycleRuleValid = Schema.makeFilter((rule: Record<string, unknown>) => {
  const action = rule.action as { type: string; storageClass?: string } | undefined
  if (action?.type === 'SetStorageClass' && !action?.storageClass) {
    return {
      path: ['action', 'storageClass'],
      issue: 'storageClass is required when action type is SetStorageClass',
    }
  }
})

/** Abort early when any lifecycle rule validation fails — no need to keep checking. */
const lifecycleRuleValidAbort = lifecycleRuleValid.abort()

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const isValidOrigin = (s: string): boolean => {
  try {
    const url = new URL(s)
    return url.origin === s || url.origin + '/' === s
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const LifecycleRuleSchema = Schema.Struct({
  action: Schema.Struct({
    type: Schema.Union([Schema.Literal('Delete'), Schema.Literal('SetStorageClass')]),
    storageClass: Schema.optional(
      Schema.Union([
        Schema.Literal('STANDARD'),
        Schema.Literal('ENHANCED_THROUGHPUT'),
        Schema.Literal('INTELLIGENT'),
        Schema.Literal('FILESYSTEM'),
      ]),
    ),
  }),
  condition: Schema.Struct({
    age: Schema.optional(Schema.Finite),
    createdBefore: Schema.optional(Schema.String),
    isLive: Schema.optional(Schema.Boolean),
    matchesStorageClass: Schema.optional(
      Schema.Array(
        Schema.Union([
          Schema.Literal('STANDARD'),
          Schema.Literal('ENHANCED_THROUGHPUT'),
          Schema.Literal('INTELLIGENT'),
          Schema.Literal('FILESYSTEM'),
        ]),
      ),
    ),
    numNewerVersions: Schema.optional(Schema.Finite),
  }),
}).check(lifecycleRuleValidAbort)

const LifecycleAccessFilterSchema = Schema.Struct({
  lastAccessTime: Schema.optional(
    Schema.Struct({
      before: Schema.optional(Schema.String),
      after: Schema.optional(Schema.String),
    }),
  ),
  matchesStorageClass: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.Literal('STANDARD'),
        Schema.Literal('ENHANCED_THROUGHPUT'),
        Schema.Literal('INTELLIGENT'),
        Schema.Literal('FILESYSTEM'),
      ]),
    ),
  ),
})

const LifecycleConfigurationSchema = Schema.Struct({
  rules: Schema.Array(LifecycleRuleSchema),
  lastAccessFilter: Schema.optional(LifecycleAccessFilterSchema),
})

const CORSRuleSchema = Schema.Struct({
  /** Optional rule identifier. NOT branded: opaque per-rule label, not a resource ID. */
  id: Schema.optional(Schema.String),
  allowedHeaders: Schema.optional(Schema.Array(Schema.String)),
  allowedOrigins: Schema.optional(Schema.Array(Schema.String)),
  allowedMethods: Schema.optional(Schema.Array(Schema.String)),
  exposeHeaders: Schema.optional(Schema.Array(Schema.String)),
  maxAgeSeconds: Schema.optional(Schema.Finite),
}).check(corsRuleValid)

const CORSConfigurationSchema = Schema.Struct({
  rules: Schema.Array(CORSRuleSchema),
})

const BucketPolicy_RuleSchema = Schema.Struct({
  paths: Schema.Array(Schema.String),
  roles: Schema.Array(Schema.String),
  /** IAM group granted the rule's roles. */
  groupId: Schema.optional(IamIds.GroupId),
  anonymous: Schema.optional(
    Schema.Struct({
      read: Schema.optional(Schema.Boolean),
      write: Schema.optional(Schema.Boolean),
    }),
  ),
})

const BucketPolicySchema = Schema.Struct({
  rules: Schema.Array(BucketPolicy_RuleSchema),
})

export const BucketPropsSchema = Schema.Struct({
  parentId: Schema.optional(IamV2Ids.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  maxSizeBytes: Schema.optional(Schema.BigInt),
  lifecycleConfiguration: Schema.optional(LifecycleConfigurationSchema),
  cors: Schema.optional(CORSConfigurationSchema),
  forceStorageClass: Schema.optional(Schema.Boolean),
  bucketPolicy: Schema.optional(BucketPolicySchema),
  versioningPolicy: Schema.optional(
    Schema.Union([Schema.Literal('DISABLED'), Schema.Literal('ENABLED'), Schema.Literal('SUSPENDED')]),
  ),
  defaultStorageClass: Schema.optional(
    Schema.Union([
      Schema.Literal('STANDARD'),
      Schema.Literal('ENHANCED_THROUGHPUT'),
      Schema.Literal('INTELLIGENT'),
      Schema.Literal('FILESYSTEM'),
    ]),
  ),
  objectAuditLogging: Schema.optional(
    Schema.Union([Schema.Literal('NONE'), Schema.Literal('MUTATE_ONLY'), Schema.Literal('ALL')]),
  ),
})

export type BucketProps = typeof BucketPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateBucketProps = Validation.makeValidateProps(BucketPropsSchema)

export const BucketAttributesSchema = Schema.Struct({
  id: Ids.BucketId,
  parentId: IamV2Ids.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  versioningPolicy: Schema.Union([Schema.Literal('DISABLED'), Schema.Literal('ENABLED'), Schema.Literal('SUSPENDED')]),
  defaultStorageClass: Schema.Union([
    Schema.Literal('STANDARD'),
    Schema.Literal('ENHANCED_THROUGHPUT'),
    Schema.Literal('INTELLIGENT'),
    Schema.Literal('FILESYSTEM'),
  ]),
  objectAuditLogging: Schema.Union([Schema.Literal('NONE'), Schema.Literal('MUTATE_ONLY'), Schema.Literal('ALL')]),
  state: Schema.Union([
    Schema.Literal('CREATING'),
    Schema.Literal('ACTIVE'),
    Schema.Literal('UPDATING'),
    Schema.Literal('SCHEDULED_FOR_DELETION'),
  ]),
  suspensionState: Schema.Union([Schema.Literal('NOT_SUSPENDED'), Schema.Literal('SUSPENDED')]),
})

export type BucketAttributes = typeof BucketAttributesSchema.Type
