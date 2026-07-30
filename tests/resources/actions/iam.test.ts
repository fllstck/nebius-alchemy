import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

// ── IAM Actions ────────────────────────────────────────────────────────────

test.provider.skipIf(!process.env.SLOW_TESTS)(
  'Nebius.iam.action.GetProject / ListProjects',
  (stack) =>
    Effect.gen(function* () {
      const project = yield* stack.deploy(Nebius.iam.Project('ActionTest-Project', { region: 'eu-north1' }))

      const { projects, found, notFound } = yield* stack.deploy(
        Effect.gen(function* () {
          const projects = yield* Nebius.iam.action.ListProjects({})
          const found = yield* Nebius.iam.action.GetProject({ name: project.name })
          const notFound = yield* Nebius.iam.action.GetProject({ name: 'nonexistent-project-99999' })
          return { projects, found, notFound }
        }),
      )

      expect(found?.id).toBe(project.id)
      expect(found?.name).toBe(project.name)
      expect(projects.some((p) => p.id === project.id)).toBe(true)
      expect(notFound).toBeUndefined()
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)

test.provider.skipIf(!process.env.SLOW_TESTS)(
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
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
)
