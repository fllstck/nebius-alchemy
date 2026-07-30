import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

// ---------------------------------------------------------------------------
// Shared filter
// ---------------------------------------------------------------------------

/** Nebius resource name: 3–63 chars, lowercase alphanumeric + hyphens, can't start/end with hyphen. */
export const isDnsCompliantResourceName = Schema.makeFilter(
  (s: string) =>
    s.length >= 3 && s.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)
      ? undefined
      : `Resource name must be 3-63 lowercase alphanumeric characters or hyphens, got "${s}"`,
  { title: 'DNS-compliant resource name' },
)

/**
 * Validate IPv4 CIDR notation (e.g. "10.0.0.0/24", "0.0.0.0/0").
 * Rejects prefix-only form like "/24" — the Nebius API requires full CIDR notation.
 */
export const isValidCIDR = Schema.makeFilter(
  (s: string) => {
    // Prefix-only form: "/24", "/32" — rejected by Nebius API
    if (/^\/\d{1,2}$/.test(s)) {
      return `Prefix-only CIDR "${s}" is not accepted by the API. Use full notation e.g. "10.0.0.0${s}"`
    }
    // Full CIDR: "10.0.0.0/24"
    const parts = s.split('/')
    if (parts.length !== 2) return `Invalid CIDR notation: "${s}"`
    const ip = parts[0]!
    const prefixStr = parts[1]!
    const prefix = parseInt(prefixStr, 10)
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return `CIDR prefix must be 0-32, got "${prefixStr}"`
    const octets = ip.split('.')
    if (octets.length !== 4) return `Invalid IP address in CIDR: "${ip}"`
    for (const octet of octets) {
      const n = parseInt(octet, 10)
      if (isNaN(n) || n < 0 || n > 255) return `IP octet out of range 0-255: "${octet}"`
    }
    return undefined
  },
  { title: 'IPv4 CIDR' },
)

/** TCP/UDP port range 1–65535. */
export const isValidPort = Schema.makeFilter(
  (n: number) =>
    Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : `Port must be 1-65535, got ${n}`,
  { title: 'valid port' },
)

// ---------------------------------------------------------------------------
// Shared error
// ---------------------------------------------------------------------------

/** Raised when resource props fail runtime validation. */
export class PropsValidationError extends Schema.TaggedErrorClass<PropsValidationError>()('PropsValidationError', {
  /** Formatted validation error message from Schema.decode. */
  message: Schema.String,
}) {}

/** Raised when a resource lookup by name returns NOT_FOUND from the API. */
export class ResourceNotFoundError extends Schema.TaggedErrorClass<ResourceNotFoundError>()('ResourceNotFoundError', {
  /** Type of resource (e.g. "project", "network", "subnet"). */
  resourceType: Schema.String,
  /** The name that was looked up. */
  name: Schema.String,
  /** Parent where the lookup was performed (tenant ID, project ID, etc.). */
  parent: Schema.String,
  /** Human-readable description of the failure. */
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Map a Schema parse error into a {@link PropsValidationError}. */
export const mapParseError = (error: { message: string }): PropsValidationError =>
  new PropsValidationError({ message: error.message })

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a standard props validation function for a given schema.
 *
 * Usage:
 * ```ts
 * export const validateMyProps = makeValidateProps(MyPropsSchema)
 * ```
 */
export const makeValidateProps = <T>(schema: Schema.Schema<T>) =>
  (news: unknown) => Schema.decodeUnknownEffect(schema)(news).pipe(Effect.mapError(mapParseError))

// ---------------------------------------------------------------------------
// Resource ID format validators
// ---------------------------------------------------------------------------

/**
 * Creates a filter that validates a Nebius resource ID matches the expected
 * prefix pattern (e.g. "project-", "serviceaccount-").
 *
 * This catches accidentally passing the wrong ID type (e.g. a service account
 * ID where a project ID is expected) before the API call.
 */
export const isResourceId = (prefix: string, label: string) =>
  Schema.makeFilter(
    (s: string) =>
      s.length > 0 && s.startsWith(prefix)
        ? undefined
        : `Expected ${label} ID (should start with "${prefix}"), got "${s}"`,
    { title: `${label} ID` },
  )

// ---------------------------------------------------------------------------
// Additional format validators
// ---------------------------------------------------------------------------

/** Basic email format validation. */
export const isValidEmail = Schema.makeFilter(
  (s: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? undefined : `Invalid email format: "${s}"`,
  { title: 'email' },
)

/** Basic URL format validation (http or https). */
export const isValidUrl = Schema.makeFilter(
  (s: string) =>
    /^https?:\/\/.+/.test(s) ? undefined : `URL must start with http:// or https://, got "${s}"`,
  { title: 'URL' },
)

/** PEM-encoded certificate or public key validation. */
export const isPemFormat = Schema.makeFilter(
  (s: string) =>
    s.startsWith('-----BEGIN ') && s.includes('-----END ')
      ? undefined
      : `Expected PEM-encoded data (must contain BEGIN/END markers), got "${s.slice(0, 50)}..."`,
  { title: 'PEM data' },
)

/** Block size must be a power of two between 4096 and 131072. */
export const isValidBlockSize = Schema.makeFilter(
  (n: number) => {
    if (n < 4096 || n > 131072) return `Block size must be between 4096 and 131072, got ${n}`
    if ((n & (n - 1)) !== 0) return `Block size must be a power of two, got ${n}`
    return undefined
  },
  { title: 'valid block size' },
)
