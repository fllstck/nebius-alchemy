export * from './Provider.ts'

import * as storage from './resources/storage/v1/index.ts'
import * as iam from './resources/iam/index.ts'
import * as vpc from './resources/vpc/v1/index.ts'
import * as compute from './resources/compute/v1/index.ts'
import * as dns from './resources/dns/v1/index.ts'
import * as mysterybox from './resources/mysterybox/v1/index.ts'
import * as kms from './resources/kms/v1/index.ts'
import * as quotas from './resources/quotas/v1/index.ts'
import * as capacity from './resources/capacity/v1/index.ts'
// Billing ships **references only** today (`PricingPolicyId`): the `pricing_model` oneof on compute
// Instance / mk8s NodeGroup / ai Job+Endpoint names a Pricing Policy, and a brand is what keeps that id
// from travelling as a bare string. No provider — see `resources/billing/v1/index.ts`.
import * as billing from './resources/billing/v1/index.ts'
import * as ai from './resources/ai/v1/index.ts'
import * as mk8s from './resources/mk8s/v1/index.ts'

export { storage, iam, vpc, compute, dns, mysterybox, kms, quotas, capacity, billing, ai, mk8s }