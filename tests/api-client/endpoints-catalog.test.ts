import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as EndpointsModule from '../../modules/endpoints.ts'

const { describe, expect, test } = BunTest
const { endpointFor } = EndpointsModule

// ---------------------------------------------------------------------------
// Endpoint catalog drift detection
//
// `modules/endpoints.ts` is a hand-maintained mirror of the upstream Nebius API
// catalog (`endpoints.md` in github.com/nebius/api, copied to ENDPOINTS.md).
// Nothing kept it in sync with the generated protobuf schemas, so a schema bump
// could add a service whose endpoint was never mapped, failing at runtime with
// `UnknownServiceError` — a failure that is invisible to `tsc` and to every
// provider test, because it only fires when that service is first called.
//
// This suite closes that gap mechanically: it derives the set of services that
// actually exist from the generated `*_service.ts` files and asserts every one
// of them resolves. Adding a service upstream without mapping its endpoint now
// fails here instead of in production.
// ---------------------------------------------------------------------------

const SCHEMAS_DIR = path.join(import.meta.dir, '../../schemas')

/** Services that exist upstream but have no published endpoint in the catalog. */
const NO_CATALOG_ENDPOINT: ReadonlyArray<string> = []

/**
 * Collect fully-qualified service names from generated ts-proto output.
 *
 * Every generated service definition carries its FQ name in the method path
 * constants (`path: "/nebius.compute.v1.InstanceService/Get"`), which is
 * emitted from the proto package + service declaration — so it cannot drift
 * from the wire name we must look up.
 */
const generatedServiceNames = (): ReadonlyArray<string> => {
  if (!fs.existsSync(SCHEMAS_DIR)) return []

  const names = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('_service.ts')) {
        const source = fs.readFileSync(full, 'utf8')
        for (const match of source.matchAll(/path: "\/((?:nebius)\.[\w.]+)\//g)) {
          const [, service] = match
          if (service) names.add(service)
        }
      }
    }
  }

  walk(SCHEMAS_DIR)
  return [...names].sort()
}

/**
 * Resolve `service`, reporting a failure as `null` instead of throwing, so the
 * whole catalog can be checked in one pass.
 */
const resolveOrNull = (service: string): string | null =>
  Effect.runSync(
    endpointFor(service).pipe(
      Effect.catch(() => Effect.succeed(null)),
    ),
  )

describe('endpoints catalog', () => {
  const services = generatedServiceNames()

  test('generated schemas are present', () => {
    // Skip-by-empty would hide a missing generation step in CI, so assert it.
    expect(services.length).toBeGreaterThan(0)
  })

  test('every generated service has an endpoint mapping', () => {
    const allowlist = new Set(NO_CATALOG_ENDPOINT)
    const unmapped = services.filter((s) => !allowlist.has(s) && resolveOrNull(s) === null)

    expect(unmapped).toEqual([])
  })

  // Pins the services added by the nebius/api bump to
  // 1396e2a05b3379967512d4d00d102e57705302dd — these are the entries whose
  // absence the drift check above would otherwise only catch as a *count*
  // change, not as a wrong host.
  test.each([
    ['nebius.storage.v1.InventoryService', 'cpl.storage.api.nebius.cloud:443'],
    ['nebius.ai.v1.DevlabService', 'apps.msp.api.nebius.cloud:443'],
    ['nebius.applications.v1alpha1.VmAppTemplateService', 'deployment-manager.mkt.api.nebius.cloud:443'],
    ['nebius.monitoring.v1.RecordingRuleService', 'monitoring.api.nebius.cloud:443'],
    ['nebius.capacity.v1.CapacityAllowanceService', 'capacity-blocks.billing-cpl.api.nebius.cloud:443'],
    ['nebius.tunnel.v1.TunnelService', 'applicationtunnel.mkt.api.nebius.cloud:443'],
  ])('%s resolves to %s', (service, endpoint) => {
    expect(resolveOrNull(service)).toBe(endpoint)
  })

  test('unknown services still fail (no catch-all fallback)', () => {
    expect(resolveOrNull('nebius.nonexistent.v1.FakeService')).toBeNull()
  })
})
