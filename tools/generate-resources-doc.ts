#!/usr/bin/env bun
/**
 * Generate `RESOURCES.md` — the API reference for every implemented resource — from the schemas.
 *
 *   bun tools/generate-resources-doc.ts          # write RESOURCES.md
 *   bun tools/generate-resources-doc.ts --check  # exit 1 if RESOURCES.md is stale (used by a test)
 *
 * Why generated: a 41-resource reference is exactly the kind of document that rots silently. Today's
 * sessions found two examples of that (a coverage table whose rows had drifted out of the table, and a
 * roll-out claim contradicted by a live control), so this file is derived from the source of truth — each
 * resource's `*PropsSchema` and `*AttributesSchema` — and a test re-runs it to prove it is current.
 *
 * What it extracts per prop:
 *   * **required vs optional** — the `Schema.optional(...)` wrapper;
 *   * **type** — the schema expression verbatim (`Ids.ClusterId`, `Schema.Record(Schema.String, …)`,
 *     a nested `Schema.Struct({…})` collapsed to `{ … }`), with inline filters lifted out;
 *   * **plan-time validation** — every `.check(...)` it can name: inline `Validation.x('arg')` calls on the
 *     prop, and the named struct-level filters (`exactlyOneSizing`, `bootDiskImageRequired`, …), which are
 *     the rules that fail `alchemy plan` rather than apply.
 *
 * Attributes are listed by name (they are the read side; their types live in the generated schemas).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'RESOURCES.md')
const CHECK = process.argv.includes('--check')

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })

const NON_RESOURCE =
  /(\.schema\.ts$|\/index\.ts$|\/ids\.ts$|\/bindings\.ts$|\/hosted\.ts$|\/actions\.ts$|\/shared\/|(factory|utilities|validation)\.ts$)/
const TYPE_ALIAS_FORM = /Alchemy\.Resource<\s*'([\w.]+)'/
const CALL_FORM = /Alchemy\.Resource<[^(]*>\s*\(\s*'([\w.]+)'/

/** The brace-balanced block starting at the first `{` at or after `from`. */
const balanced = (source: string, from: number): { text: string; end: number } => {
  const open = source.indexOf('{', from)
  if (open === -1) return { text: '', end: from }
  let depth = 0
  let quote: string | undefined
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? ''
    if (quote !== undefined) {
      if (char === quote && source[index - 1] !== '\\') quote = undefined
      continue
    }
    // Comments first: a doc comment is full of apostrophes and quoted phrases, and treating one as the
    // start of a string literal swallows the rest of the struct (found the hard way — an `ai/v1` props
    // table came out as a single prop whose type ran to the end of the file).
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index)
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? source.length : close + 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return { text: source.slice(open, index + 1), end: index }
    }
  }
  return { text: source.slice(open), end: source.length }
}

/** Split a struct body into top-level members on depth-0 commas. */
const members = (body: string): Array<{ key: string; text: string; doc?: string }> => {
  const inner = body.trim().replace(/^\{/, '').replace(/\}$/, '')
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? ''
    if (quote !== undefined) {
      current += char
      if (char === quote && inner[index - 1] !== '\\') quote = undefined
      continue
    }
    // Comments are kept in `current` (their text is the prop's documentation) but skipped for depth and
    // quoting — a doc comment's apostrophes are not string literals.
    if (char === '/' && inner[index + 1] === '*') {
      const close = inner.indexOf('*/', index + 2)
      const end = close === -1 ? inner.length : close + 2
      current += inner.slice(index, end)
      index = end - 1
      continue
    }
    if (char === '/' && inner[index + 1] === '/') {
      const lineEnd = inner.indexOf('\n', index)
      const end = lineEnd === -1 ? inner.length : lineEnd
      current += inner.slice(index, end)
      index = end - 1
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
      const withoutDoc = part.replace(/\/\*\*[\s\S]*?\*\//g, '')
      const match = /^\s*(\w+)\??\s*:\s*([\s\S]+)$/.exec(withoutDoc)
      if (match === null) return undefined
      const summary = doc === undefined ? undefined : firstSentence(doc)
      const fallback = doc === undefined ? undefined : docDefault(doc)
      return {
        key: match[1]!,
        text: match[2]!.trim(),
        ...(summary === undefined ? {} : { doc: summary }),
        ...(fallback === undefined ? {} : { default: fallback }),
      }
    })
    .filter((entry): entry is { key: string; text: string; doc?: string; default?: string } => entry !== undefined)
}

/** The doc comment as one line, leading `*` markers stripped. */
const docText = (doc: string): string =>
  doc
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('@'))
    .join(' ')

/** The first sentence of a doc comment. */
const firstSentence = (doc: string): string => {
  const text = docText(doc)
  const stop = text.search(/\.(\s|$)/)
  return (stop === -1 ? text : text.slice(0, stop + 1)).replace(/\|/g, '\\|')
}

/**
 * A **documented** default, lifted from the prop's own doc comment.
 *
 * That is where this repo records defaults on purpose (`Default: RECOVER`, `Default: 4096`,
 * `Defaults to the region's public-images parent`, `Omitted = provider-declared …`), so the column is
 * documentation-derived rather than behaviour-derived: an empty cell means *no default is documented at the
 * prop*, not that there is none. Three kinds of default are therefore out of its reach and are stated once
 * in the file header instead: the provider's own fallbacks (`parentId` → `NEBIUS_PROJECT_ID`, `name` → a
 * generated physical name), request-only fields, and anything the platform decides but does not document
 * (where the doc says so, e.g. `os`/`preset` coming from the compatibility matrix).
 */
const docDefault = (doc: string): string | undefined => {
  const text = docText(doc)
  const patterns = [
    /(?:^|[.·(]\s*)Defaults? to ([^.;)]+)/i,
    /(?:^|[.·(]\s*)Defaults? ([^.;)]+)/i,
    /(?:^|[.·(]\s*)Default: ([^.;)]+)/i,
    /(?:^|[.·(]\s*)Omitted = ([^.;)]+)/i,
    /(?:^|[.·(]\s*)Omitted means ([^.;)]+)/i,
    /(?:^|[.·(]\s*)omit it (?:and|to) ([^.;)]+)/i,
    /(?:^|[.·(]\s*)([^.;)]+) is the (?:platform|API|service|server) default/i,
  ]
  for (const pattern of patterns) {
    const found = pattern.exec(text)
    if (found !== null) {
      const phrase = (found[1] ?? '').split('(')[0]!.trim().replace(/[·,;:]$/, '')
      if (phrase !== '') return phrase.replace(/\|/g, '\\|')
    }
  }
  return undefined
}

/** `Schema.optional(X)` → `{ required: false, type: X }`. */
const unwrapOptional = (text: string): { required: boolean; type: string } =>
  /^Schema\.optional\(([\s\S]*)\)$/.test(text)
    ? { required: false, type: /^Schema\.optional\(([\s\S]*)\)$/.exec(text)![1]!.trim() }
    : { required: true, type: text }

/**
 * Every `.check(...)` name on a schema expression, split into the prop-level ones (kept as validations) and
 * the remaining type expression. `Validation.isNonEmptyString('x')` → `isNonEmptyString('x')`; a named
 * reference like `exactlyOnePricingArm` → `exactlyOnePricingArm`.
 */
const splitChecks = (type: string, structFilters: ReadonlyArray<string>): { type: string; checks: string[] } => {
  const checks: string[] = []
  let stripped = type
  // Balanced-paren scan: a `.check(Schema.makeFilter((value) => …))` contains its own parentheses, and a
  // regex-based strip left the filter body in the type cell (visible in the first generated draft).
  for (;;) {
    const at = stripped.indexOf('.check(')
    if (at === -1) break
    let depth = 0
    let end = -1
    for (let index = at + '.check'.length; index < stripped.length; index += 1) {
      if ((stripped[index] ?? '') === '(') depth += 1
      else if ((stripped[index] ?? '') === ')') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    if (end === -1) break
    const argument = stripped.slice(at + '.check('.length, end).trim()
    const named = /^(?:Validation\.)?(\w+)\s*(\([\s\S]*\))?$/.exec(argument)
    checks.push(named === null ? 'inline filter' : `${named[1]}${named[2] ?? ''}`)
    stripped = stripped.slice(0, at) + stripped.slice(end + 1)
  }
  return { type: stripped, checks: [...checks, ...structFilters] }
}

/**
 * Make a schema expression readable in a table cell: collapse whitespace, drop the `| undefined` arms that
 * `Schema.optional` already implies, and show a nested struct's **field names** (bounded) rather than its
 * whole body — `{ platform, preset, … }` tells a reader more than `{ … }` without pasting 20 fields.
 */
const tidy = (type: string): string => {
  let text = type.replace(/\s+/g, ' ')
  // Collapse every `Schema.Struct(<body>)` to `{ … }`, innermost-out, with the balanced reader. The *field
  // names* of a nested struct are not repeated in a type cell on purpose: this reference expands one level
  // into dotted sub-rows (`template.maxPods`, `bootDisk.…`), which is where a reader wants them.
  for (let pass = 0; pass < 8; pass += 1) {
    const at = text.indexOf('Schema.Struct(')
    if (at === -1) break
    const body = balanced(text, at + 'Schema.Struct'.length).text
    const span = 'Schema.Struct('.length + body.length + 1
    text = text.slice(0, at) + '{ … }' + text.slice(at + span)
  }
  return text
    .replace(/\s*\|\s*undefined/g, '')
    .replace(/\{\s*…\s*\}\s*,?\s*\}/g, '{ … }')
    .replace(/\s*,\s*\}/g, ' }')
    .replace(/\s*,\s*\)/g, ')')
    .replace(/\s*,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim()
}

interface Resource {
  readonly type: string
  readonly module: string
  readonly props: ReadonlyArray<{
    key: string
    required: boolean
    type: string
    checks: string[]
    doc?: string
    default?: string
  }>
  readonly attributes: ReadonlyArray<{ key: string; required: boolean; type: string; doc?: string }>
  readonly resourceFilters: ReadonlyArray<string>
}

/**
 * Required-first, then alphabetical. An API reference is read by scanning for "what must I pass", so the
 * required props lead; alphabetical inside each group keeps a prop findable without reading the table.
 */
const byRequiredThenName = <T extends { key: string; required: boolean }>(list: ReadonlyArray<T>): T[] =>
  [...list].sort((a, b) => (a.required === b.required ? a.key.localeCompare(b.key) : a.required ? -1 : 1))

const resources: Resource[] = []

for (const path of walk(join(ROOT, 'modules/resources'))) {
  const relative = path.slice(ROOT.length + 1)
  if (NON_RESOURCE.test(relative)) continue
  const source = readFileSync(path, 'utf8')
  const type =
    TYPE_ALIAS_FORM.exec(source)?.[1] ??
    CALL_FORM.exec(source)?.[1]
  if (type === undefined) continue
  const publicType = type.replace(/\.v\d+\./, '.')

  // The props and attributes schemas may live in the provider file or beside it.
  const schemaPath = path.replace(/\.ts$/, '.schema.ts')
  const schemaSource = readFileSync(path, 'utf8') + (schemaPath === path ? '' : readFileSync(schemaPath, 'utf8').replace(/^/, '\n'))

  const propsMatch = /export const (\w+PropsSchema) = Schema\.Struct\(/.exec(schemaSource)
  if (propsMatch === null) continue
  const propsAt = schemaSource.indexOf(propsMatch[0]) + propsMatch[0].length - 1
  const propsBlock = balanced(schemaSource, propsAt)
  // Named struct-level filters: `}).check(a).check(b)` right after the props struct.
  const trailing = schemaSource.slice(propsBlock.end, propsBlock.end + 400)
  const resourceFilters = [...trailing.matchAll(/\.check\((\w+)(?:\([^)]*\))?\)/g)].map((match) => match[1]!)

  /** Local `const XSchema = Schema.Struct({ … })` definitions, so a named prop type can be expanded. */
  const localStructs = new Map<string, string>()
  for (const found of schemaSource.matchAll(/const (\w+) = Schema\.Struct\(/g)) {
    const at = (found.index ?? 0) + found[0].length - 1
    localStructs.set(found[1]!, balanced(schemaSource, at).text)
  }

  /** The struct body behind a prop's type, when it is one this file defines (or an inline literal). */
  const structBodyOf = (rawType: string): string | undefined => {
    const inline = rawType.startsWith('Schema.Struct(') ? balanced(rawType, 0).text : undefined
    if (inline !== undefined) return inline
    const named = /^(\w+)$/.exec(rawType)?.[1]
    return named === undefined ? undefined : localStructs.get(named)
  }

  const describeMember = (member: { key: string; text: string; doc?: string; default?: string }) => {
    const { required, type: inner } = unwrapOptional(member.text)
    const { type: cleaned, checks } = splitChecks(inner, [])
    return {
      key: member.key,
      required,
      type: tidy(cleaned),
      checks,
      rawType: cleaned.trim(),
      ...(member.doc === undefined ? {} : { doc: member.doc }),
      ...(member.default === undefined ? {} : { default: member.default }),
    }
  }

  /**
   * Top-level props, then **one level** of the nested structs that most need documenting (`template.*` on a
   * node group, `bootDisk.*` on an instance), as dotted sub-rows. One level, because the reference is for
   * scanning: deeper nesting is the generated schema's job, and the `type` cell names it.
   */
  const props = byRequiredThenName(members(propsBlock.text).map(describeMember)).flatMap((prop) => {
    const body = structBodyOf(prop.rawType)
    if (body === undefined) return [prop]
    const children = byRequiredThenName(members(body).map(describeMember)).map((child) => ({
      ...child,
      key: `${prop.key}.${child.key}`,
    }))
    return children.length === 0 ? [prop] : [prop, ...children]
  })

  const attrsMatch = /export const (\w+AttributesSchema) = Schema\.Struct\(/.exec(schemaSource)
  const attributes =
    attrsMatch === null
      ? []
      : byRequiredThenName(
          members(balanced(schemaSource, schemaSource.indexOf(attrsMatch[0]) + attrsMatch[0].length - 1).text).map(
            (member) => {
              const { required, type: inner } = unwrapOptional(member.text)
              const { type: cleaned } = splitChecks(inner, [])
              // Attributes are the read side: the schema is authoritative here too, but a *validator* on an
              // output is not a plan-time rule, so the checks are dropped rather than reported.
              return {
                key: member.key,
                required,
                type: tidy(cleaned),
                ...(member.doc === undefined ? {} : { doc: firstSentence(member.doc) }),
              }
            },
          ),
        )

  resources.push({ type: publicType, module: relative, props, attributes, resourceFilters })
}

resources.sort((a, b) => a.type.localeCompare(b.type))

const anchor = (type: string) => type.toLowerCase().replace(/[^a-z0-9]+/g, '')

const lines: string[] = []
lines.push('# Resources — API reference')
lines.push('')
lines.push(
  'Every implemented resource, with its props (required vs optional), the **type** of each prop as the schema',
  'declares it, and the **plan-time validations** — the rules that fail `alchemy plan` (or the plan\'s props',
  'validation) instead of an apply. Generated from the schemas by',
  '[`tools/generate-resources-doc.ts`](tools/generate-resources-doc.ts): `bun run docs:resources`, and',
  '`tests/resources-doc.test.ts` fails when this file is stale.',
)
lines.push('')
lines.push(
  'The **documented default** column is lifted from each prop\'s own doc comment, which is where this repo',
  'records defaults. A dash means *no default is documented at that prop* — not that there is none: three',
  'kinds are out of its reach and are named here once. (1) The provider\'s own fallbacks: `parentId` defaults',
  'to `NEBIUS_PROJECT_ID` where the resource is project-scoped, optional `name` to a generated physical name,',
  '`os`/`resources.preset` on a node group to the platform\'s compatibility matrix. (2) Request-only fields',
  '(`invitation.{noSend,expiresInSeconds}`). (3) Values the platform decides and does not document, where the',
  'prop says so instead.',
)
lines.push('')
lines.push(
  'The narrative for each resource — what it is for, what is measured against real infra, and the API traps —',
  'is in [README.md § Resources](README.md#resources); each heading below links back to it.',
)
lines.push('')
lines.push(`${resources.length} resources.`)
lines.push('')
lines.push('## Index')
lines.push('')
for (const resource of resources) {
  lines.push(`- [\`${resource.type}\`](#${anchor(resource.type)})`)
}
lines.push('')

/**
 * The README section that documents a resource, resolved from the README itself: the `### <heading>` whose
 * body contains the resource's bullet. Guessing an anchor from the service name produced `#compute-1`, which
 * is not a heading — the bullet is the authority.
 */
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const README_SECTIONS = (() => {
  const sections: Array<{ title: string; anchor: string; body: string }> = []
  const headingPattern = /^#{2,3} (.+)$/gm
  const found = [...readme.matchAll(headingPattern)]
  for (const [index, match] of found.entries()) {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < found.length ? (found[index + 1]?.index ?? readme.length) : readme.length
    const title = (match[1] ?? '').trim()
    const anchor = title
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
    sections.push({ title, anchor, body: readme.slice(start, end) })
  }
  return sections
})()

const readmeLink = (resource: Resource): { label: string; anchor: string } => {
  // The bullets in §Resources are **linked** to this file (`- **[`Nebius.x.y`](RESOURCES.md#anchor)** — …`),
  // so the plain `**\`Nebius.x.y\`**` form no longer appears there: match either.
  const section = README_SECTIONS.find(
    (candidate) =>
      candidate.body.includes(`**\`${resource.type}\`**`) ||
      candidate.body.includes(`RESOURCES.md#${anchor(resource.type)}`) ||
      candidate.body.includes(`**\`${resource.type}\``),
  )
  return section === undefined
    ? { label: 'Resources', anchor: 'resources' }
    : { label: section.title, anchor: section.anchor }
}

for (const resource of resources) {
  const link = readmeLink(resource)
  lines.push(`## \`${resource.type}\``)
  lines.push('')
  lines.push(
    `*Defined in [\`${resource.module}\`](${resource.module}). Narrative and live-verification status: ` +
      `[README.md § ${link.label}](README.md#${link.anchor}).*`,
  )
  lines.push('')
  lines.push('| prop | required | type | documented default | plan-time validation |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const prop of resource.props) {
    const checks = prop.checks.length === 0 ? '—' : prop.checks.map((check) => `\`${check}\``).join(' ')
    const fallback = prop.default === undefined ? '—' : prop.default
    lines.push(`| \`${prop.key}\` | ${prop.required ? '**yes**' : 'no'} | \`${prop.type}\` | ${fallback} | ${checks} |`)
  }
  lines.push('')
  if (resource.resourceFilters.length > 0) {
    lines.push(
      `Resource-level validations (they compare several props, so they are not attached to one row): ` +
        resource.resourceFilters.map((filter) => `\`${filter}\``).join(', ') +
        '.',
    )
    lines.push('')
  }
  if (resource.attributes.length > 0) {
    lines.push('### Returned values')
    lines.push('')
    lines.push('| attribute | always present | type | documented as |')
    lines.push('| --- | --- | --- | --- |')
    for (const attribute of resource.attributes) {
      lines.push(
        `| \`${attribute.key}\` | ${attribute.required ? '**yes**' : 'no'} | \`${attribute.type}\` | ${
          attribute.doc ?? '—'
        } |`,
      )
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('')
}

const output = lines.join('\n')
if (CHECK) {
  const current = (() => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return ''
    }
  })()
  if (current !== output) {
    console.error('RESOURCES.md is stale — run `bun run docs:resources` (the resource schemas changed).')
    process.exit(1)
  }
  console.log('RESOURCES.md is current')
} else {
  writeFileSync(OUT, output)
  console.log(`wrote RESOURCES.md — ${resources.length} resources`)
}
