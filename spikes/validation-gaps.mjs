/**
 * Audit purpose: find props whose documentation states a hard rule but whose schema enforces none.
 *
 * For every top-level prop of every resource it pairs the prop's doc comment with the `.check(...)` filters on
 * it, flags docs that use requirement language ("must", "requires", "only", "cannot", "rejected", "at least",
 * "at most", "≥", "≤") without a filter, and lists resources with no plan-time validation at all.
 *
 *   bun spikes/validation-gaps.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/Users/kay/Development/nebius-alchemy'
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
  })
const NON_RESOURCE =
  /(\.schema\.ts$|\/index\.ts$|\/ids\.ts$|\/bindings\.ts$|\/hosted\.ts$|\/actions\.ts$|\/shared\/|(factory|utilities|validation)\.ts$)/
const TYPE_ALIAS = /Alchemy\.Resource<\s*'([\w.]+)'/
const CALL = /Alchemy\.Resource<[^(]*>\s*\(\s*'([\w.]+)'/

const balanced = (source, from) => {
  const open = source.indexOf('{', from)
  let depth = 0
  let quote
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? ''
    if (quote !== undefined) {
      if (char === quote && source[index - 1] !== '\\') quote = undefined
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2) + 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return source.slice(open)
}

const members = (body) => {
  const inner = body.trim().replace(/^\{/, '').replace(/\}$/, '')
  const parts = []
  let depth = 0
  let quote
  let current = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (quote !== undefined) {
      current += char
      if (char === quote && inner[index - 1] !== '\\') quote = undefined
      continue
    }
    if (char === '/' && inner[index + 1] === '*') {
      const close = inner.indexOf('*/', index + 2)
      current += inner.slice(index, close + 2)
      index = close + 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
      continue
    }
    if ('{[('.includes(char)) depth += 1
    if ('}])'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current)
  return parts
    .map((part) => {
      const doc = /\/\*\*([\s\S]*?)\*\//.exec(part)?.[1]
      const without = part.replace(/\/\*\*[\s\S]*?\*\//g, '')
      const match = /^\s*(\w+)\??\s*:\s*([\s\S]+)$/.exec(without)
      if (match === null) return undefined
      return { key: match[1], text: match[2].trim(), doc: doc ?? '' }
    })
    .filter(Boolean)
}

const REQUIREMENT = /\b(must|requires?|only|cannot|rejected?|at least|at most|no more than|≥|≤|not allowed)\b/i

const noValidation = []
const suspicious = []

for (const path of walk(join(ROOT, 'modules/resources'))) {
  const relative = path.slice(ROOT.length + 1)
  if (NON_RESOURCE.test(relative)) continue
  const provider = readFileSync(path, 'utf8')
  const type = TYPE_ALIAS.exec(provider)?.[1] ?? CALL.exec(provider)?.[1]
  if (type === undefined) continue
  const schemaPath = path.replace(/\.ts$/, '.schema.ts')
  const source = provider + readFileSync(schemaPath, 'utf8')
  const match = /export const (\w+PropsSchema) = Schema\.Struct\(/.exec(source)
  if (match === null) continue
  const at = source.indexOf(match[0]) + match[0].length - 1
  const block = balanced(source, at)
  const resourceFilters = [
    ...source
      .slice(source.indexOf(block) + block.length, source.indexOf(block) + block.length + 400)
      .matchAll(/\.check\((\w+)/g),
  ].map((found) => found[1])
  const props = members(block)
  const checked = props.filter((prop) => prop.text.includes('.check(')).length
  if (checked === 0 && resourceFilters.length === 0) noValidation.push(`${type} (${relative})`)
  for (const prop of props) {
    const flatDoc = prop.doc.replace(/\s+/g, ' ')
    if (REQUIREMENT.test(flatDoc) && !prop.text.includes('.check(')) {
      const first = flatDoc.replace(/^\s*\*\s?/, '').split(/\.(\s|$)/)[0]
      suspicious.push({ type: type.replace(/\.v\d+\./, '.'), prop: prop.key, why: first.slice(0, 150) })
    }
  }
  if (resourceFilters.length > 0) {
    continue
  }
}

console.log(`\n=== resources with NO plan-time validation at all (${noValidation.length}) ===`)
for (const entry of noValidation) console.log('  ' + entry)

console.log(`\n=== props whose doc states a rule but which has no filter (${suspicious.length}) ===`)
const byType = new Map()
for (const entry of suspicious) {
  if (!byType.has(entry.type)) byType.set(entry.type, [])
  byType.get(entry.type).push(entry)
}
for (const [type, entries] of byType) {
  console.log(`  ${type}`)
  for (const entry of entries) console.log(`    ${entry.prop} — ${entry.why}`)
}
