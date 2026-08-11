import * as BunTest from 'bun:test'
import {
  renderEnvFile,
  quoteEnvValue,
  renderHostedUserData,
  mergeUserData,
  planHostedUploads,
} from '../../../../modules/resources/compute/v1/hosted.ts'

const { describe, expect, test } = BunTest

describe('hosted renderEnvFile', () => {
  test('sorts keys deterministically', () => {
    const env = renderEnvFile({ ZEBRA: 'z', ALPHA: 'a', MIDDLE: 'm' })
    expect(env).toBe("ALPHA='a'\nMIDDLE='m'\nZEBRA='z'")
  })

  test('quotes values with shell-style single quotes', () => {
    expect(renderEnvFile({ KEY: 'value' })).toBe("KEY='value'")
  })

  test('escapes embedded single quotes (systemd EnvironmentFile)', () => {
    expect(quoteEnvValue("it's")).toBe("'it'\"\"'s'")
  })

  test('escapes newlines', () => {
    expect(quoteEnvValue('line1\nline2')).toBe("'line1\\nline2'")
  })

  test('JSON-stringifies non-string values', () => {
    expect(renderEnvFile({ PORT: 3000, FLAG: true })).toBe("FLAG='true'\nPORT='3000'")
  })

  test('renders the full runtime env shape', () => {
    const env = renderEnvFile({
      ALCHEMY_STACK_NAME: 'Compute',
      ALCHEMY_STAGE: 'dev',
      ALCHEMY_PHASE: 'runtime',
      PORT: 8080,
      FOO: 'bar',
    })
    const lines = env.split('\n')
    expect(lines).toContain("ALCHEMY_PHASE='runtime'")
    expect(lines).toContain("ALCHEMY_STACK_NAME='Compute'")
    expect(lines).toContain("ALCHEMY_STAGE='dev'")
    expect(lines).toContain("PORT='8080'")
  })
})

describe('hosted renderHostedUserData', () => {
  const userData = renderHostedUserData({
    unitName: 'api-runtime-abc123',
    bucketName: 'nebius-assets-bucket',
    region: 'eu-north1',
    manifestKey: 'compute/api-runtime-abc123/manifest.json',
    fetchAccessKeyId: 'AKIAFETCHKEY123',
    fetchSecretAccessKey: 'secret-fetch-key',
  })

  test('installs bun (skips when present, retries network install) via runcmd', () => {
    expect(userData.startsWith('#cloud-config')).toBe(true)
    expect(userData).toContain('curl -fsSL https://bun.sh/install | bash')
    expect(userData).toContain('for attempt in 1 2 3 4 5; do')
    expect(userData).toContain('if [ ! -x /root/.bun/bin/bun ]; then')
    // The bun installer requires unzip — the driverless image doesn't ship it.
    expect(userData).toContain('apt-get install -y unzip')
  })

  test('writes the fetch script (write_files) carrying the manifest flow + the DEDICATED read-only key', () => {
    expect(userData).toContain('- path: /usr/local/bin/api-runtime-abc123-fetch.sh')
    // Manifest is the atomic pointer — the fetch reads it FIRST.
    expect(userData).toContain('manifest = json.loads(get_object(manifest_key))')
    expect(userData).toContain('compute/api-runtime-abc123/manifest.json')
    // Content-addressed files + env are pulled per the manifest.
    expect(userData).toContain('for entry in [manifest["entry"]] + manifest.get("chunks", []):')
    expect(userData).toContain('env_data = get_object(manifest["env"]["key"])')
    // The dedicated key is embedded in the fetch script.
    expect(userData).toContain('AWS_ACCESS_KEY_ID="AKIAFETCHKEY123"')
    expect(userData).toContain('AWS_SECRET_ACCESS_KEY="secret-fetch-key"')
    // SigV4 request signing (GET with x-amz-* headers).
    expect(userData).toContain('x-amz-content-sha256')
    expect(userData).toContain('AWS4-HMAC-SHA256')
  })

  test('writes a systemd unit (write_files) with unconditional ExecStartPre re-fetch + Restart=always', () => {
    expect(userData).toContain('- path: /etc/systemd/system/api-runtime-abc123.service')
    // ExecStartPre re-fetches on EVERY start — crash restarts self-heal.
    expect(userData).toContain('ExecStartPre=/usr/local/bin/api-runtime-abc123-fetch.sh')
    expect(userData).toContain('Restart=always')
    expect(userData).toContain('RestartSec=5')
    expect(userData).toContain('EnvironmentFile=-/opt/api-runtime-abc123/env')
    expect(userData).toContain('ExecStart=/root/.bun/bin/bun --no-install /opt/api-runtime-abc123/index.mjs')
    // --no-install: never fall into bun's auto-install path.
    expect(userData).toContain('--no-install')
    // runcmd enables + starts the service.
    expect(userData).toContain('systemctl enable --now api-runtime-abc123.service')
  })

  test('the fetch key appears ONLY in the fetch script, never in the unit or env file', () => {
    const fetchStart = userData.indexOf('- path: /usr/local/bin/api-runtime-abc123-fetch.sh')
    const unitStart = userData.indexOf('- path: /etc/systemd/system/api-runtime-abc123.service')
    const fetchSection = userData.slice(fetchStart, unitStart)
    const rest = userData.slice(unitStart)
    expect(fetchSection).toContain('secret-fetch-key')
    expect(rest).not.toContain('secret-fetch-key')
    expect(rest).not.toContain('AKIAFETCHKEY123')
  })
})

describe('hosted planHostedUploads', () => {
  const files = [
    { path: 'index.mjs', content: 'console.log(1)', hash: 'hash-entry' },
    { path: 'chunk-abc.mjs', content: 'console.log(2)', hash: 'hash-chunk' },
  ]
  const env = { FOO: 'bar', PORT: 3000 }

  test('writes the manifest LAST (the atomic pointer)', () => {
    const { writes, manifest } = planHostedUploads({ assetPrefix: 'compute/unit', files, env })
    expect(writes.filter((write) => write.manifest)).toHaveLength(1)
    const manifestIndex = writes.findIndex((write) => write.manifest)
    expect(manifestIndex).toBe(writes.length - 1)
    expect(writes[manifestIndex]!.key).toBe('compute/unit/manifest.json')
    expect(manifest).toBeDefined()
  })

  test('content-addresses files and env (immutable keys)', () => {
    const { writes } = planHostedUploads({ assetPrefix: 'compute/unit', files, env })
    const keys = writes.map((write) => write.key)
    expect(keys).toContain('compute/unit/files/hash-entry/index.mjs')
    expect(keys).toContain('compute/unit/files/hash-chunk/chunk-abc.mjs')
    // Env key embeds the env content hash (stable key would let a VM on the
    // OLD manifest observe the NEW env mid-deploy).
    const envWrite = writes[2]!
    expect(envWrite.key).toMatch(/^compute\/unit\/env\/[0-9a-f]{64}$/)
    expect(envWrite.content).toBe(renderEnvFile(env))
  })

  test('manifest lists entry first, then chunks, plus the env key', () => {
    const { manifest } = planHostedUploads({ assetPrefix: 'compute/unit', files, env })
    expect(manifest).toEqual({
      schema: 1,
      entry: { path: 'index.mjs', key: 'compute/unit/files/hash-entry/index.mjs', hash: 'hash-entry' },
      chunks: [{ path: 'chunk-abc.mjs', key: 'compute/unit/files/hash-chunk/chunk-abc.mjs', hash: 'hash-chunk' }],
      env: { key: expect.stringMatching(/^compute\/unit\/env\/[0-9a-f]{64}$/), hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
  })

  test('empty file list produces no manifest write', () => {
    const { writes, manifest } = planHostedUploads({ assetPrefix: 'compute/unit', files: [], env })
    expect(writes.some((write) => write.manifest)).toBe(false)
    expect(manifest).toBeUndefined()
  })
})

describe('hosted mergeUserData', () => {
  const bootstrap = '#cloud-config\nwrite_files: []\nruncmd: []\n'
  const user = '#!/bin/bash\necho hello\n'

  test('returns the bootstrap alone when no user data', () => {
    expect(mergeUserData(bootstrap)).toBe(bootstrap)
  })

  test('merges via MIME multipart — bootstrap part first, user script part after', () => {
    const merged = mergeUserData(bootstrap, user)
    expect(merged.startsWith('Content-Type: multipart/mixed; boundary="//alchemy-nebius//"')).toBe(true)
    expect(merged).toContain('Content-Type: text/cloud-config; charset="us-ascii"')
    expect(merged).toContain('Content-Type: text/x-shellscript; charset="us-ascii"')
    expect(merged.indexOf('text/cloud-config')).toBeLessThan(merged.indexOf('text/x-shellscript'))
    expect(merged).toContain(user)
    expect(merged.trimEnd().endsWith('--//alchemy-nebius//--')).toBe(true)
  })

  test('a user #cloud-config part keeps the cloud-config content type', () => {
    const merged = mergeUserData(bootstrap, '#cloud-config\npackages: []\n')
    expect(merged).toContain('text/cloud-config; charset="us-ascii"')
    expect(merged).not.toContain('text/x-shellscript')
  })
})
