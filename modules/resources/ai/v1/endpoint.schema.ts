import * as Schema from 'effect/Schema'
import * as ProjectSchema from '../../iam/v2/project.schema.ts'
import * as Ids from './ids.ts'

import * as JobSchema from './job.schema.ts'
import * as Validation from '../../validation.ts'

// ---------------------------------------------------------------------------
// Endpoint Props (user input)
// ---------------------------------------------------------------------------

/**
 * `authToken` and `authTokenMysteryboxSecret` are mutually exclusive —
 * either may be set, or neither (authentication disabled), never both.
 */
const authTokenValid = Schema.makeFilter((props: Record<string, unknown>) => {
  if (props.authToken !== undefined && props.authTokenMysteryboxSecret !== undefined) {
    return {
      path: [],
      issue: 'Only one of "authToken" or "authTokenMysteryboxSecret" may be specified, not both',
    }
  }
})

export const EndpointPropsSchema = Schema.Struct({
  parentId: Schema.optional(ProjectSchema.ProjectId),
  name: Schema.optional(Schema.String.check(Validation.isDnsCompliantResourceName)),
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** The Docker image to run the endpoint's container. */
  image: Schema.String,
  /** Compute platform, e.g. "cpu-d3", "gpu-h200-sxm". */
  platform: Schema.String,
  /** Compute preset for the platform, e.g. "4vcpu-16gb". */
  preset: Schema.String,
  /** Subnet ID where the endpoint will be deployed. */
  subnetId: Schema.String,
  /** Whether to assign a public IP to the endpoint. */
  publicIp: Schema.Boolean,
  /** Whether to use a preemptible VM (cheaper, can be stopped by the platform). */
  preemptible: Schema.Boolean,
  /** Entrypoint command for the endpoint's container. */
  containerCommand: Schema.optional(Schema.String),
  /** Arguments to pass to the entrypoint command. */
  args: Schema.optional(Schema.String),
  /** Working directory for the endpoint's container. */
  workingDir: Schema.optional(Schema.String),
  /** Environment variables for the endpoint's container. */
  environmentVariables: Schema.Array(JobSchema.EnvironmentVariableSchema),
  /** Ports that the endpoint exposes. */
  ports: Schema.Array(JobSchema.PortSchema),
  /** Volumes to be mounted into the endpoint's container. */
  volumes: Schema.Array(JobSchema.VolumeMountSchema),
  /** Main disk spec for the endpoint. Required by the API. */
  disk: JobSchema.JobDiskSchema,
  /** Public keys authorized for SSH access to the endpoint. */
  sshAuthorizedKeys: Schema.optional(Schema.Array(Schema.String)),
  /** Shared memory size in bytes for the endpoint's container. */
  shmSizeBytes: Schema.optional(Schema.Finite),
  /** Small config files injected into the container before the user process starts. */
  injectedFiles: Schema.optional(Schema.Array(JobSchema.FileInjectionSchema)),
  /** Registry credentials for private Docker registries. */
  registryCredentials: Schema.optional(JobSchema.RegistryCredentialsSchema),
  /**
   * Authentication token needed to access the endpoint.
   * Mutually exclusive with `authTokenMysteryboxSecret`. If not provided,
   * authentication is disabled.
   */
  authToken: Schema.optional(Schema.String),
  /** Secret storing the authentication token. Mutually exclusive with `authToken`. */
  authTokenMysteryboxSecret: Schema.optional(JobSchema.MysteryBoxSecretRefSchema),
}).check(authTokenValid)

export type EndpointProps = typeof EndpointPropsSchema.Type

// ---------------------------------------------------------------------------
// Props validation helper
// ---------------------------------------------------------------------------

export const validateEndpointProps = Validation.makeValidateProps(EndpointPropsSchema)

// ---------------------------------------------------------------------------
// Endpoint Attributes (output)
// ---------------------------------------------------------------------------

export const EndpointAttributesSchema = Schema.Struct({
  id: Ids.EndpointId,
  parentId: ProjectSchema.ProjectId,
  name: Schema.String,
  labels: Schema.Array(Schema.String),
  state: Schema.Union([
    Schema.Literal('PROVISIONING'),
    Schema.Literal('STARTING'),
    Schema.Literal('RUNNING'),
    Schema.Literal('STOPPING'),
    Schema.Literal('DELETING'),
    Schema.Literal('STOPPED'),
    Schema.Literal('ERROR'),
    Schema.Literal('IMAGE_PULLING'),
  ]),
  publicEndpoints: Schema.Array(Schema.String),
  privateEndpoints: Schema.Array(Schema.String),
  /**
   * The endpoint's bearer auth token. The API never echoes it back after
   * create (one-time value, like the AccessKey secret) — synthesized from
   * props, which Alchemy state persists across deploys, so bindings can read
   * it off the resource handle (AI_BINDINGS.md AD1).
   */
  authToken: Schema.optional(Schema.String),
})

export type EndpointAttributes = typeof EndpointAttributesSchema.Type
