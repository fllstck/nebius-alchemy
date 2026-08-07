/**
 * Async-style Worker entry for the bindings example (tiny bundle variant).
 *
 * Reads the `NEBIUS_S3_*` env bindings injected at deploy time by the
 * `*Binding` layers and drives s3-lite-client directly. No Effect runtime, no
 * alchemy runtime machinery — the bundle is a fraction of the Effect-native
 * variant's size.
 *
 * The trade: you lose the typed `GetObject`/`PutObject` contracts in the
 * worker (you read `env` + drive s3-lite yourself) but keep the full
 * deploy-time wiring: host identity mint, editors-group grant, access key,
 * and the env injection.
 */
import { S3Client } from '@bradenmacdonald/s3-lite-client'

interface BindingsEnv {
  NEBIUS_S3_ENDPOINT: string
  NEBIUS_REGION: string
  NEBIUS_ACCESS_KEY_ID: string
  NEBIUS_SECRET_ACCESS_KEY: string
  NEBIUS_BUCKET_NAME: string
}

const makeClient = (env: BindingsEnv): S3Client =>
  new S3Client({
    endPoint: env.NEBIUS_S3_ENDPOINT,
    region: env.NEBIUS_REGION,
    accessKey: env.NEBIUS_ACCESS_KEY_ID,
    secretKey: env.NEBIUS_SECRET_ACCESS_KEY,
    bucket: env.NEBIUS_BUCKET_NAME,
    pathStyle: true,
  })

export default {
  async fetch(request: Request, env: BindingsEnv): Promise<Response> {
    const client = makeClient(env)

    if (request.method === 'POST') {
      const body = await request.text()
      await client.putObject('dir/hello.txt', body || 'hello from the async bindings example', {
        metadata: { 'Content-Type': 'text/plain' },
      })
      return new Response('stored', { status: 201 })
    }

    try {
      const object = await client.getObject('dir/hello.txt')
      const text = await object.text()
      return new Response(text, { status: 200 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(`error: ${message}`, { status: 500 })
    }
  },
}
