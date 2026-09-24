import * as BunTest from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const { describe, expect, test } = BunTest

/**
 * `RESOURCES.md` is generated, so it must be **current** — a reference that describes yesterday's props is
 * worse than no reference, and this session produced two examples of documentation drifting away from the
 * code it described (a coverage table whose rows had fallen out of the table, and a roll-out claim a live
 * control disproved).
 *
 * The generator is idempotent and exits 1 with a message naming the fix, so this is a one-line guard
 * rather than a second implementation of the parser.
 */
describe('RESOURCES.md', () => {
  test('is up to date with the resource schemas', () => {
    const result = spawnSync('bun', [join(import.meta.dir, '..', 'tools/generate-resources-doc.ts'), '--check'], {
      encoding: 'utf8',
    })
    expect(
      result.status,
      `${result.stdout}${result.stderr}\n` +
        'RESOURCES.md is stale: run `bun run docs:resources` and commit the result. (The doc is generated ' +
        'from each resource\'s *PropsSchema — a prop added or a filter changed in the code means the ' +
        'reference has to move with it.)',
    ).toBe(0)
  })
})
