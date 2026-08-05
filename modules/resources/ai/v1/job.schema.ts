import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema'
import * as Ids from './ids.ts'

import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Shared nested sub-schemas (reused by endpoint.schema.ts)
// ---------------------------------------------------------------------------

/** Reference to a MysteryBox secret (secret + version). */
export const MysteryBoxSecretRefSchema = Schema.Struct({
  secretId: Schema.String,
  versionId: Schema.String,
})

/** Exactly one of `value` / `mysteryboxSecret` must be provided. */
const environmentVariableValid = Schema.makeFilter((env: Record<string, unknown>) => {
  const hasValue = env.value !== undefined
  const hasSecret = env.mysteryboxSecret !== undefined
  if (hasValue === hasSecret) {
    return {
      path: [],
      issue: 'Environment variable must specify exactly one of "value" or "mysteryboxSecret"',
    }
  }
})

export const EnvironmentVariableSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  mysteryboxSecret: Schema.optional(MysteryBoxSecretRefSchema),
}).check(environmentVariableValid)

export const PortSchema = Schema.Struct({
  containerPort: Schema.Finite,
  hostPort: Schema.optional(Schema.Finite),
  protocol: Schema.Union([Schema.Literal('HTTP'), Schema.Literal('TCP'), Schema.Literal('UDP')]),
})

export const S3CredentialsSchema = Schema.Struct({
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
  sessionToken: Schema.optional(Schema.String),
})

/** Exactly one of `credentials` / `mysteryboxSecret` must be provided. */
const s3ConfigValid = Schema.makeFilter((config: Record<string, unknown>) => {
  const hasCredentials = config.credentials !== undefined
  const hasSecret = config.mysteryboxSecret !== undefined
  if (hasCredentials === hasSecret) {
    return {
      path: [],
      issue: 'S3 config must specify exactly one of "credentials" or "mysteryboxSecret"',
    }
  }
})

export const S3ConfigSchema = Schema.Struct({
  endpoint: Schema.String,
  region: Schema.String,
  credentials: Schema.optional(S3CredentialsSchema),
  mysteryboxSecret: Schema.optional(MysteryBoxSecretRefSchema),
}).check(s3ConfigValid)

export const VolumeMountSchema = Schema.Struct({
  source: Schema.String,
  sourcePath: Schema.optional(Schema.String),
  containerPath: Schema.String,
  mode: Schema.Union([Schema.Literal('READ_ONLY'), Schema.Literal('READ_WRITE')]),
  s3Config: Schema.optional(S3ConfigSchema),
})

/** Matches the `DiskSpec_DiskType` enum values from the compute protobuf. */
export const DiskTypeSchema = Schema.Union([
  Schema.Literal('NETWORK_SSD'),
  Schema.Literal('NETWORK_HDD'),
  Schema.Literal('NETWORK_SSD_NON_REPLICATED'),
  Schema.Literal('NETWORK_SSD_IO_M3'),
])

export const JobDiskSchema = Schema.Struct({
  type: DiskTypeSchema,
  /** Disk size in bytes. */
  sizeBytes: Schema.Finite,
})

export const RegistryCredentialsSchema = Schema.Union([
  Schema.Struct({ username: Schema.String, password: Schema.String }),
  Schema.Struct({ mysteryboxSecretVersion: Schema.String }),
])

/**
 * Strict base64 check for injected file content. The proto `Buffer` is decoded
 * from base64 on create, and Node's lenient `Buffer.from(s, 'base64')` silently
 * drops invalid characters — reject early instead of writing a corrupted file
 * into the container.
 */
const isBase64Content = Schema.makeFilter(
  (s: string) =>
    s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
      ? undefined
      : `File content must be base64-encoded (length divisible by 4), got "${s.slice(0, 24)}${s.length > 24 ? '…' : ''}"`,
  { title: 'base64 content' },
)

/** Content is a base64-encoded string (proto `Buffer`). */
export const FileInjectionSchema = Schema.Struct({
  containerPath: Schema.String,
  content: Schema.String.check(isBase64Content),
})

// ---------------------------------------------------------------------------
// Job Props (user input)
// ---------------------------------------------------------------------------

export const JobPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The Docker image to run the job's container. */
  image: Schema.String,
  /** Compute platform, e.g. "cpu-d3", "gpu-h200-sxm". */
  platform: Schema.String,
  /** Compute preset for the platform, e.g. "4vcpu-16gb". */
  preset: Schema.String,
  /** Subnet ID where the job will be deployed. */
  subnetId: Schema.String,
  /** Whether to assign a public IP to the job. */
  publicIp: Schema.Boolean,
  /** Whether to use a preemptible VM (cheaper, can be stopped by the platform). */
  preemptible: Schema.Boolean,
  /** Entrypoint command for the job's container. */
  containerCommand: Schema.optional(Schema.String),
  /** Arguments to pass to the entrypoint command. */
  args: Schema.optional(Schema.String),
  /** Working directory for the job's container. */
  workingDir: Schema.optional(Schema.String),
  /** Environment variables for the job's container. */
  environmentVariables: Schema.Array(EnvironmentVariableSchema),
  /** Ports that the job exposes. */
  ports: Schema.Array(PortSchema),
  /** Volumes to be mounted into the job's container. */
  volumes: Schema.Array(VolumeMountSchema),
  /** Main disk spec for the job. Required by the API. */
  disk: JobDiskSchema,
  /** Public keys authorized for SSH access to the job. */
  sshAuthorizedKeys: Schema.optional(Schema.Array(Schema.String)),
  /** Restart attempts for the job. */
  restartAttempts: Schema.optional(Schema.Finite),
  /** Shared memory size in bytes for the job's container. */
  shmSizeBytes: Schema.optional(Schema.Finite),
  /** Job timeout. */
  timeout: Schema.optional(Schema.Struct({ seconds: Schema.Finite, nanos: Schema.optional(Schema.Finite) })),
  /** Small config files injected into the container before the user process starts. */
  injectedFiles: Schema.optional(Schema.Array(FileInjectionSchema)),
  /** Registry credentials for private Docker registries. */
  registryCredentials: Schema.optional(RegistryCredentialsSchema),
})

export type JobProps = typeof JobPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateJobProps = Validation.makeValidateProps(JobPropsSchema)

// ---------------------------------------------------------------------------
// Job Attributes (output)
// ---------------------------------------------------------------------------

export const JobAttributesSchema = Schema.Struct({
  id: Ids.JobId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  state: Schema.Union([
    Schema.Literal('PROVISIONING'),
    Schema.Literal('STARTING'),
    Schema.Literal('RUNNING'),
    Schema.Literal('CANCELLING'),
    Schema.Literal('DELETING'),
    Schema.Literal('COMPLETED'),
    Schema.Literal('FAILED'),
    Schema.Literal('CANCELLED'),
    Schema.Literal('ERROR'),
    Schema.Literal('IMAGE_PULLING'),
  ]),
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
})

export type JobAttributes = typeof JobAttributesSchema.Type
