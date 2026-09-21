import { describe, expect, test } from 'bun:test'
import Long from 'long'

import { nvlInstanceGroupListRequest } from '../../modules/api-client/compute.ts'

/**
 * The NVL InstanceGroup service rejects `pageSize: 100` with
 * `3 INVALID_ARGUMENT: PageSize is invalid`, while the VPC / compute / mysterybox
 * lists all accept it (both probed live 2026-09-21). The list request must leave
 * `pageSize` unset — a neighbouring service is the obvious template to copy, so
 * this pins the odd one out.
 */
describe('nvlInstanceGroupListRequest', () => {
  test('leaves pageSize unset — this service rejects 100', () => {
    const request = nvlInstanceGroupListRequest('project-e00eq4g7pr00j746m1fttd', '')

    expect(request.pageSize.equals(Long.ZERO)).toBe(true)
    expect(request.parentId).toBe('project-e00eq4g7pr00j746m1fttd')
  })

  test('carries the page token through for paging', () => {
    expect(nvlInstanceGroupListRequest('project-1', 'token-2').pageToken).toBe('token-2')
  })
})
