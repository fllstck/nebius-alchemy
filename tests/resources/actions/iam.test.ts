import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../helpers/stack.ts'
import { expect } from 'bun:test'
import * as Validation from '../../../modules/resources/validation.ts'
import { integrationTest } from '../../helpers/gate.ts'
import { safeDestroy } from '../../helpers/cleanup.ts'

// ── IAM Actions ────────────────────────────────────────────────────────────

integrationTest(
  test.provider,
  'Nebius.iam.action.GetProject / ListProjects',
  (stack) =>
    Effect.gen(function* () {
      const project = yield* stack.deploy(Nebius.iam.Project('ActionTest-Project', { region: 'eu-north1' }))

      const { projects, found } = yield* stack.deploy(
        Effect.gen(function* () {
          const projects = yield* Nebius.iam.action.ListProjects({})
          const found = yield* Nebius.iam.action.GetProject({ name: project.name })
          return { projects, found }
        }),
      )

      expect(found?.id).toBe(project.id)
      expect(found?.name).toBe(project.name)
      expect(projects.some((p) => p.id === project.id)).toBe(true)

      // The not-found path is a separate action instance (distinct logical id —
      // same-name actions in one stack share a single output) and fails with
      // ResourceNotFoundError by contract. Effect.flip surfaces the deploy's
      // failure as the success value.
      const notFound = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* Nebius.iam.action.GetProject('NotFoundCheck', { name: 'nonexistent-project-99999' })
          }),
        )
        .pipe(Effect.flip)
      expect(notFound).toBeInstanceOf(Validation.ResourceNotFoundError)
    }).pipe(safeDestroy(stack)),
  // Budget for a full PROJECT lifecycle, not just the action calls: the deploy
  // creates a real project (~22s) and `safeDestroy` waits out its deletion,
  // which polls for ~90s (logged as "Still deleting … — 30s/60s elapsed").
  // The calls themselves take ~4s — see `GetGroup / ListGroups` below, whose
  // resources delete instantly. Measured 2026-09-18: 120s was below the real
  // cost and failed under full-suite load.
  { timeout: 300_000 },
)

integrationTest(
  test.provider,
  'Nebius.iam.action.GetGroup / ListGroups',
  (stack) =>
    Effect.gen(function* () {
      const group = yield* stack.deploy(Nebius.iam.Group('ActionTest-Group', {}))

      const { groups, found } = yield* stack.deploy(
        Effect.gen(function* () {
          const groups = yield* Nebius.iam.action.ListGroups({})
          const found = yield* Nebius.iam.action.GetGroup({ name: group.name })
          return { groups, found }
        }),
      )

      expect(found?.id).toBe(group.id)
      expect(groups.some((g) => g.id === group.id)).toBe(true)
    }).pipe(safeDestroy(stack)),
  { timeout: 120_000 },
)
