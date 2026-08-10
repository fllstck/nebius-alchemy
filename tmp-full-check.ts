import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as SaBootstrap from '/Users/kay/Development/nebius-alchemy/modules/auth/sa-bootstrap.ts'
import * as SaToken from '/Users/kay/Development/nebius-alchemy/modules/auth/sa-token.ts'

const PROJECT = 'project-e00eq4g7pr00j746m1fttd'
const token = Redacted.make(execSync('nebius iam get-access-token', { encoding: 'utf8' }).trim())

const result = await Effect.runPromise(
  Effect.result(
    Effect.gen(function* () {
      const bootstrap = yield* SaBootstrap.SaBootstrap
      const key = yield* bootstrap.bootstrap(token, {
        parentId: PROJECT,
        serviceAccountName: 'sa-full-check',
        grant: { role: 'editor', resourceId: PROJECT },
      })
      const minted = yield* SaToken.exchangeToken(SaToken.signJwt(key))
      return { key, minted }
    }).pipe(Effect.provide(SaBootstrap.SaBootstrapLive)),
  ),
)
if (result._tag === 'Failure') { console.error('FAILED:', result.failure.message); process.exit(1) }
const { key, minted } = result.success
writeFileSync('/tmp/sa-minted-token', minted)
console.log(`SA=${key.serviceAccountId}`)
console.log(`KEY=${key.keyId}`)
console.log(`MINTED=${minted.length} chars, written to /tmp/sa-minted-token`)
