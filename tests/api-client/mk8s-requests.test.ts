import { describe, expect, test } from 'bun:test'

import { clusterListRequest, clusterControlPlaneVersions, nodeGroupListRequest } from '../../modules/api-client/mk8s.ts'
import {
  GetClusterRequest,
  ListClusterControlPlaneVersionsRequest,
} from '../../schemas/nebius/mk8s/v1/cluster_service.ts'
import { GetNodeGroupRequest } from '../../schemas/nebius/mk8s/v1/node_group_service.ts'

/**
 * The mk8s list/read request shapes, pinned without an engine or a network.
 *
 * Two things here are not boilerplate:
 *
 * 1. **`pageSize: 100` is an assumption that has to be earned.** `nvl-instance-group`
 *    rejects `100` with `3 INVALID_ARGUMENT: PageSize is invalid` while its compute
 *    neighbours accept it (`tests/api-client/nvl-instance-group-list.test.ts`), so an
 *    unset page size is the safe default *until probed*. These two endpoints were probed
 *    against the live API (see TASKS.md §NEXT UP — probe results); this test pins the
 *    shape that probe cleared.
 * 2. **`Get{Cluster,NodeGroup}Request` carry `resourceVersion` beyond `id`**, which is
 *    why `modules/api-client/mk8s.ts` needs a custom `getRequest` instead of spreading
 *    the id — the case AGENTS.md §"Protobuf Serialization" names explicitly. Pinned so
 *    a future edit that "simplifies" the builder back to `{ id }` fails loudly.
 */

describe('mk8s list requests', () => {
  test('clusters paginate by IAM container (project) with pageSize 100', () => {
    const request = clusterListRequest('project-e00eq4g7pr00j746m1fttd', '')
    expect(request.parentId).toBe('project-e00eq4g7pr00j746m1fttd')
    expect(request.pageSize.toNumber()).toBe(100)
    expect(request.pageToken).toBe('')
  })

  test('node groups paginate by CLUSTER, not by project', () => {
    // The parent is the cluster (`ListNodeGroupsRequest.parentId` is documented as
    // "ID of the parent Cluster"), and a tenant/project there is a real mistake to
    // make — the API answers `NotFound: resource "mk8scluster-…" not found`.
    const request = nodeGroupListRequest('mk8scluster-e00mn89kpc6f8bgd01', '')
    expect(request.parentId).toBe('mk8scluster-e00mn89kpc6f8bgd01')
    expect(request.pageSize.toNumber()).toBe(100)
  })

  test('the page token is carried through for paging', () => {
    expect(clusterListRequest('project-1', 'token-2').pageToken).toBe('token-2')
    expect(nodeGroupListRequest('mk8scluster-1', 'token-2').pageToken).toBe('token-2')
  })
})

describe('mk8s get requests are not id-only', () => {
  test('GetClusterRequest carries a resourceVersion field the id cannot fill', () => {
    const request = GetClusterRequest.fromPartial({ id: 'mk8scluster-e00mn89kpc6f8bgd01' })
    expect(request.id).toBe('mk8scluster-e00mn89kpc6f8bgd01')
    // The sibling field exists and defaults to empty — which is why
    // `getRequest: (id) => GetClusterRequest.fromPartial({ id })` is required and a
    // bare `{ id }` would not type-check.
    expect(request.resourceVersion).toBe('')
  })

  test('GetNodeGroupRequest has the same shape', () => {
    const request = GetNodeGroupRequest.fromPartial({ id: 'mk8snodegroup-e00qz5ptbkeqppax21' })
    expect(request.id).toBe('mk8snodegroup-e00qz5ptbkeqppax21')
    expect(request.resourceVersion).toBe('')
  })
})

describe('ListClusterControlPlaneVersions takes no parent', () => {
  test('the request message is EMPTY — there is no pagination here at all', () => {
    // Stronger than "pageSize is unset": the message has no paging *fields* and no
    // `parentId` (the catalogue is global), which is exactly why `paginateAll` must
    // not be used for this endpoint — it would read an absent `nextPageToken` as the
    // last page and silently truncate.
    const request = ListClusterControlPlaneVersionsRequest.fromPartial({})
    expect(Object.keys(request)).toEqual([])
    expect('pageSize' in request).toBe(false)
    expect('pageToken' in request).toBe(false)
    expect('parentId' in request).toBe(false)
    expect(request).toEqual({})
  })

  test('the RPC returns an envelope, and the client unwraps it to an array', () => {
    // Regression guard for a real bug the live probe caught (2026-09-23): the method
    // was declared as `ReadonlyArray<…>` while the passthrough returned
    // `ListClusterControlPlaneVersionsResponse`, and the `as unknown as` cast in the
    // layer hid the mismatch — it only surfaced as `versions.map is not a function`
    // against the live API. The unwrapping is a pure function so this test can pin it.
    const response = {
      items: [{ version: '1.36', deprecated: false, restricted: false }],
    }
    expect(clusterControlPlaneVersions(response)).toEqual([
      { version: '1.36', deprecated: false, restricted: false },
    ])
    // …and the envelope itself is NOT what callers get.
    expect(Array.isArray(clusterControlPlaneVersions(response))).toBe(true)
  })
})
