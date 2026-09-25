#!/usr/bin/env bun
/**
 * Schema-conformance audit for the two repo-wide rules in AGENTS.md
 * (§"Naming — schema casing, verbatim", §"Branded IDs — everywhere").
 *
 *   bun tools/schema-conformance.ts
 *
 * **Exit code 1** if a resource type string or a prop field casing deviates from the generated
 * schema, or if a bare-string ID field has no in-place reason.
 *
 * ## How an ID exception is declared
 *
 * The scan reports every `*Id` / `*Ids` / `id` / `ids` field — in props, attributes *and* error
 * schemas — that is a bare `Schema.String` (or an optional/array of one). A field is approved when
 * its **own leading doc comment** contains the exact marker `NOT branded`, which is also where the
 * reason has to live:
 *
 * ```ts
 * /** Optional rule identifier. NOT branded: opaque per-rule label, not a resource ID. *\/
 * id: Schema.optional(Schema.String),
 * ```
 *
 * The marker travels with the field, so it cannot go stale the way an entry in a second allowlist
 * file would, and `grep -rn "NOT branded" modules/resources/` is the whole exception inventory.
 * The comment must be the one *immediately* above the field: a marker elsewhere in the file does
 * not excuse it (pinned in `tests/tools/schema-conformance.test.ts`, because a scan of the whole
 * file would approve everything and look identical from the outside).
 *
 * Deliberately strict, in three ways worth knowing before "fixing" it:
 *
 * - The field must be on its own line, indented by at least two spaces — that is where the report
 *   looks ([`ID_FIELD`]). A same-line `/** … *\/ id: …` is therefore neither reported nor approved;
 *   the repo style is a preceding line, so the gap is a false *negative*, never a false pass.
 * - The marker is the literal `NOT branded`. "not a Nebius resource ID", "deliberately unbranded"
 *   and similar read fine to a human and are rejected here, because a loose pattern is how the
 *   rules this file enforces got their reputation (`nebius/no-effect-ignore` could not see the only
 *   form in the repo, R-05).
 * - An approved field still has to *be* a bare string: branding it and leaving the marker behind is
 *   not an error, but the marker then no longer matches anything and the field simply stops being
 *   reported.
 *
 * Both checks are heuristic on purpose: the type-string check is exact, the casing check is exact
 * for depth-1 struct keys, and the ID check is a candidate list judged by the in-place reason.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name)
    if (d.isDirectory()) return walk(p)
    return d.name.endsWith('.ts') ? [p] : []
  })

/** `key:` names at brace depth 1 of the object literal starting at `open`. */
const depthOneKeys = (text: string, open: number): string[] => {
  const keys: string[] = []
  let depth = 0
  let i = open
  let quote: string | null = null
  let lineStart = open + 1
  while (i < text.length) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      i++
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) {
        const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(lineStart, i).split('\n').slice(-1)[0] ?? '')
        if (m) keys.push(m[1]!)
        break
      }
    }
    if (c === '\n' && depth === 1) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(lineStart, i))
      lineStart = i
      if (m) keys.push(m[1]!)
    }
    i++
  }
  return keys
}

// ── ID-candidate classification (pure, and pinned by a test) ─────────────────

/**
 * One bare-string ID field the scan found.
 *
 * Keyed by `where` + `field`, never by line: the report prints the line, but a reason that had to be
 * re-typed on every edit above it would be a reason nobody maintains.
 */
export interface IdCandidate {
  /** `svc/ver/<resource>` — from the schema file's path. */
  readonly where: string
  /** 1-based line of the field, for the report only. */
  readonly line: number
  readonly field: string
  /** The declaration, e.g. `Schema.optional(Schema.String)`. */
  readonly declaration: string
  /** The field's own `NOT branded` line, when it has one. */
  readonly reason?: string
}

/** The literal every approved exception has to carry. */
export const BRAND_EXCEPTION_MARKER = 'NOT branded'

const COMMENT_LINE = /^\s*(\/\*\*|\/\*|\*|\/\/)/

/**
 * The `NOT branded` line from the doc comment *immediately* above `lines[index]`, if there is one.
 *
 * Walks up only over contiguous comment lines, so a marker on a neighbouring field — or anywhere
 * else in the file — does not approve this one. That is the property the test pins: scanning the
 * file for the marker would approve every candidate in it while looking identical from outside.
 */
export const leadingBrandMarkerReason = (lines: ReadonlyArray<string>, index: number): string | undefined => {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!COMMENT_LINE.test(line)) return undefined
    // Strip only the *leading* comment decoration (and a trailing `*/`), so emphasis inside the
    // reason survives — `SID *value*` reads as written in the report.
    if (line.includes(BRAND_EXCEPTION_MARKER)) return line.trim().replace(/^\/\*\*?|^\/\/|^\*|\*\/$/g, '').trim()
  }
  return undefined
}

/** Split the candidates into the ones with an in-place reason and the ones without. */
export const partitionIdCandidates = (candidates: ReadonlyArray<IdCandidate>) => ({
  approved: candidates.filter((candidate) => candidate.reason !== undefined),
  unapproved: candidates.filter((candidate) => candidate.reason === undefined),
})

// ── generated schema: message names per service dir ─────────────────────────
const messagesByDir = new Map<string, Set<string>>()
for (const file of walk(join(ROOT, 'schemas/nebius'))) {
  const rel = file.replace(join(ROOT, 'schemas/nebius') + '/', '')
  const [pkg, ver, base] = rel.split('/')
  if (!base || !ver?.startsWith('v') || base.endsWith('_service.ts')) continue
  const key = `${pkg}/${ver}`
  const set = messagesByDir.get(key) ?? new Set<string>()
  for (const m of readFileSync(file, 'utf8').matchAll(/export interface ([A-Za-z_]\w*) \{/g)) set.add(m[1]!)
  messagesByDir.set(key, set)
}

const ID_FIELD = /^\s{2,}(id|ids|[A-Za-z_][\w]*Id|[A-Za-z_][\w]*Ids):\s*(.+)$/
const BARE_STRING =
  /^Schema\.String\b|^Schema\.optional\(Schema\.String\b|^Schema\.Array\(Schema\.String\b|^Schema\.optional\(Schema\.Array\(Schema\.String\b/
const STRUCT_OPEN = /(?:export )?const (\w+) = Schema\.Struct\(\{/g
const SPEC_INTERFACE = /export interface (\w*Spec\w*) \{/g

/** Run the audit. Returns the process exit code (0 = conformant). */
export const audit = (): number => {
  const caseFailures: string[] = []
  const idCandidates: IdCandidate[] = []
  let typeStringsChecked = 0

  const serviceDirs = readdirSync(join(ROOT, 'modules/resources'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((svc) => {
      const svcDir = join(ROOT, 'modules/resources', svc.name)
      return readdirSync(svcDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^v\d/.test(d.name))
        .map((v) => ({ svc: svc.name, ver: v.name, path: join(svcDir, v.name) }))
    })

  for (const { svc, ver, path: dir } of serviceDirs) {
    // (1) resource type strings vs generated message names
    const messages = messagesByDir.get(`${svc}/${ver}`)
    if (messages) {
      for (const file of walk(dir).filter(
        (f) => !f.endsWith('.schema.ts') && !f.endsWith('ids.ts') && !f.endsWith('actions.ts'),
      )) {
        const rel = file.replace(join(ROOT, 'modules/resources') + '/', '')
        const text = readFileSync(file, 'utf8')
        const typeStrings = [
          ...text.matchAll(/Alchemy\.Resource<\s*'([^']+)'/g),
          ...text.matchAll(/Alchemy\.Platform<\s*'([^']+)'/g),
          ...text.matchAll(/Alchemy\.Platform<[\s\S]{0,400}?>\('([^']+)'/g),
        ].map((m) => m[1]!)
        for (const full of typeStrings) {
          const message = full.split('.').slice(3).join('.')
          if (!message) continue
          typeStringsChecked++
          if (!messages.has(message)) {
            const ci = [...messages].find((x) => x.toLowerCase() === message.toLowerCase())
            caseFailures.push(`${rel}: '${full}' — schema has ${ci ? '`' + ci + '`' : 'no case-insensitive match'}`)
          }
        }
      }
    }

    // (2) casing-only prop↔spec mismatches, and bare-string ID candidates
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.schema.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8')
      const res = f.replace('.schema.ts', '')
      const genFile = join(ROOT, `schemas/nebius/${svc}/${ver}/${res}.ts`)
      if (existsSync(genFile)) {
        const genText = readFileSync(genFile, 'utf8')
        const genKeys = [...genText.matchAll(SPEC_INTERFACE)].flatMap((m) =>
          depthOneKeys(genText, genText.indexOf('{', m.index)),
        )
        for (const m of text.matchAll(STRUCT_OPEN)) {
          const open = text.indexOf('{', m.index + m[0].length - 1)
          for (const k of depthOneKeys(text, open)) {
            if (genKeys.includes(k)) continue
            const ci = genKeys.find((g) => g.toLowerCase() === k.toLowerCase())
            if (ci) caseFailures.push(`${svc}/${ver}/${res}: ${m[1]}.${k} — schema spells it \`${ci}\``)
          }
        }
      }
      // The ID scan is LINE-wise on purpose: the structural parse above is
      // depth-1 only and drops fields inside long nested blocks (measured: 10 of
      // 35 candidates), which would silently shrink this list.
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        const m = ID_FIELD.exec(line)
        if (!m) return
        const [, name, decl] = m
        const trimmed = decl!.trim().replace(/,$/, '')
        if (/Schema\.brand/.test(trimmed) || !BARE_STRING.test(trimmed)) return
        const reason = leadingBrandMarkerReason(lines, index)
        idCandidates.push({
          where: `${svc}/${ver}/${res}`,
          line: index + 1,
          field: name!,
          declaration: trimmed,
          ...(reason === undefined ? {} : { reason }),
        })
      })
    }
  }

  const { approved, unapproved } = partitionIdCandidates(idCandidates)

  console.log(`type strings checked: ${typeStringsChecked}`)
  console.log('\n=== CASING (must be empty) ===')
  console.log(caseFailures.length ? caseFailures.join('\n') : 'OK — no deviations')
  console.log(`\n=== BARE-STRING ID FIELDS (${approved.length} declared, ${unapproved.length} unapproved) ===`)
  if (approved.length > 0) {
    console.log('declared — the field carries its own reason:')
    for (const candidate of approved) console.log(`  ${candidate.where}:${candidate.line}  ${candidate.field} — ${candidate.reason}`)
  }
  if (unapproved.length > 0) {
    console.log('UNAPPROVED — brand it, or say why not in the field’s own doc comment:')
    for (const candidate of unapproved) {
      console.log(`  ${candidate.where}:${candidate.line}  ${candidate.field}: ${candidate.declaration}`)
      console.log(`    → add a \`${BRAND_EXCEPTION_MARKER}: <reason>\` line to the comment directly above it`)
    }
  }
  if (idCandidates.length === 0) console.log('(no bare-string ID fields — every one is branded)')

  return caseFailures.length > 0 || unapproved.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(audit())
