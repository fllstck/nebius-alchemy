import * as BunTest from 'bun:test'
import {
  renderEnvFile,
  quoteEnvValue,
  renderHostedUserData,
  mergeUserData,
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

  test('installs bun (skips when present, retries network install)', () => {
    expect(userData).toContain('if [ ! -x /root/.bun/bin/bun ]; then')
    expect(userData).toContain('curl -fsSL https://bun.sh/install | bash')
    expect(userData).toContain('for attempt in 1 2 3 4 5; do')
  })

  test('writes a fetch script carrying the manifest flow + the DEDICATED read-only key', () => {
    expect(userData).toContain(`cat >/usr/local/bin/api-runtime-abc123-fetch.sh <<'FETCH_EOF'`)
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

  test('installs a systemd unit with unconditional ExecStartPre re-fetch + Restart=always', () => {
    expect(userData).toContain('cat >/etc/systemd/system/api-runtime-abc123.service')
    // ExecStartPre re-fetches on EVERY start — crash restarts self-heal.
    expect(userData).toContain('ExecStartPre=/usr/local/bin/api-runtime-abc123-fetch.sh')
    expect(userData).toContain('Restart=always')
    expect(userData).toContain('RestartSec=5')
    expect(userData).toContain('EnvironmentFile=-/opt/api-runtime-abc123/env')
    expect(userData).toContain('ExecStart=/root/.bun/bin/bun --no-install /opt/api-runtime-abc123/index.mjs')
    // --no-install: never fall into bun's auto-install path.
    expect(userData).toContain('--no-install')
    expect(userData).toContain('systemctl enable --now api-runtime-abc123.service')
  })

  test('the fetch key appears ONLY in the fetch script, never in the unit or env file', () => {
    const fetchScriptSection = userData.slice(
      userData.indexOf("<<'FETCH_EOF'"),
      userData.indexOf('\nFETCH_EOF\n'),
    )
    const unitSection = userData.slice(userData.indexOf("<<'UNIT_EOF'"))
    expect(fetchScriptSection).toContain('secret-fetch-key')
    expect(unitSection).not.toContain('secret-fetch-key')
    expect(unitSection).not.toContain('AKIAFETCHKEY123')
  })
})

describe('hosted mergeUserData', () => {
  const bootstrap = '#!/bin/bash\n# generated\n'
  const user = '#!/bin/bash\necho hello\n'

  test('returns the bootstrap alone when no user data', () => {
    expect(mergeUserData(bootstrap)).toBe(bootstrap)
  })

  test('appends the user bootstrap after the generated one', () => {
    const merged = mergeUserData(bootstrap, user)
    expect(merged.startsWith('#!/bin/bash\n# generated')).toBe(true)
    expect(merged).toContain('# User supplied bootstrap')
    expect(merged).toContain('echo hello')
    // The user's shebang is stripped (already one script).
    expect(merged).not.toContain('#!/bin/bash\necho hello')
  })
})
