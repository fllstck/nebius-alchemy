#!/usr/bin/env bun
/**
 * Schema-conformance audit for the two repo-wide rules in AGENTS.md
 * (§"Naming — schema casing, verbatim", §"Branded IDs — everywhere").
 *
 *   bun tools/schema-conformance.ts
 *
 * Exit code 1 if a resource type string or a prop field casing deviates from the
 * generated schema. The ID report is advisory (branding is tracked in TASKS.md).
 *
 * Both checks are heuristic on purpose: the type-string check is exact, the
 * casing check is exact for depth-1 struct keys, and the ID check is a candidate
 * list — a bare `Schema.String` whose name looks like an ID is not always an ID
 * (see the exception list in TASKS.md §"Branded IDs").
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

const caseFailures: string[] = []
const idCandidates: string[] = []
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
    text.split('\n').forEach((line, index) => {
      const m = ID_FIELD.exec(line)
      if (!m) return
      const [, name, decl] = m
      const trimmed = decl!.trim().replace(/,$/, '')
      if (/Schema\.brand/.test(trimmed) || !BARE_STRING.test(trimmed)) return
      idCandidates.push(`${svc}/${ver}/${res}:${index + 1}  ${name}: ${trimmed}`)
    })
  }
}

console.log(`type strings checked: ${typeStringsChecked}`)
console.log('\n=== CASING (must be empty) ===')
console.log(caseFailures.length ? caseFailures.join('\n') : 'OK — no deviations')
console.log('\n=== BARE-STRING ID FIELDS (candidates; branded IDs only) ===')
console.log([...new Set(idCandidates)].join('\n') || '(none)')

if (caseFailures.length > 0) process.exit(1)
