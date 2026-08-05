export * from './Provider'

import * as storage from './resources/storage/v1/index.ts'
import * as iam from './resources/iam/index.ts'
import * as vpc from './resources/vpc/v1/index.ts'
import * as compute from './resources/compute/v1/index.ts'
import * as dns from './resources/dns/v1/index.ts'
import * as mysterybox from './resources/mysterybox/v1/index.ts'
import * as kms from './resources/kms/v1/index.ts'
import * as quotas from './resources/quotas/v1/index.ts'
import * as ai from './resources/ai/v1/index.ts'

export { storage, iam, vpc, compute, dns, mysterybox, kms, quotas, ai }