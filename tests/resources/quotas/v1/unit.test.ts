import * as BunTest from 'bun:test'
import * as QuotaAllowanceModule from '../../../../modules/resources/quotas/v1/quota-allowance'

const { describe, expect, test } = BunTest

describe('Nebius.quotas.v1.QuotaAllowance', () => {
  test('NebiusQuotaAllowance resource constructor is defined', () => {
    expect(QuotaAllowanceModule.NebiusQuotaAllowance).toBeDefined()
    expect(typeof QuotaAllowanceModule.NebiusQuotaAllowance).toBe('function')
  })

  test('NebiusQuotaAllowanceProvider is defined', () => {
    expect(QuotaAllowanceModule.NebiusQuotaAllowanceProvider).toBeDefined()
  })
})
