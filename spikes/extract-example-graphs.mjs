/**
 * Extract each example's resource graph so the README's diagrams can be generated from the files rather
 * than drawn from memory.
 *
 * For every `yield* Nebius.<service>.<Resource>('<LogicalId>', { … })` it records the variable, the type and
 * the logical id, then finds edges by looking for *previously declared variables* used inside the props
 * block (that is how these stacks express dependencies: `networkId: network.id`, `parentId: cluster.id`).
 *
 *   bun spikes/extract-example-graphs.mjs
 */
import { readFileSync } from 'node:fs'
import { Glob } from 'bun'

const ROOT = '/Users/kay/Development/nebius-alchemy'

/** The `{`-balanced props object starting at `from`. */
const propsBlock = (source, from) => {
  const open = source.indexOf('{', from)
  if (open === -1) return ''
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  return source.slice(open)
}

/** Whether the line the match starts on is commented out (the snippet style in these files). */
const isCommented = (source, at) => {
  const lineStart = source.lastIndexOf('\n', at) + 1
  const line = source.slice(lineStart, at)
  return /^\s*(\/\/|\*)/.test(line)
}

const files = (await Array.fromAsync(new Glob('examples/*.ts').scan(ROOT)))
  .filter((file) => !file.endsWith('-program.ts'))
  .sort()

for (const file of files) {
  const source = readFileSync(`${ROOT}/${file}`, 'utf8')
  const declared = new Map() // variable → { type, id, commented }
  const nodes = []
  const edges = []

  const pattern = /(?:const\s+(\w+)\s*=\s*)?yield\*\s*Nebius\.(\w+)\.(\w+)\(\s*'([\w-]+)'/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const [, variable, service, resource, logicalId] = match
    const commented = isCommented(source, match.index)
    const key = variable ?? logicalId
    declared.set(key, { type: `${service}.${resource}`, id: logicalId, commented })
    nodes.push({ key, ...declared.get(key) })

    // Edges: any previously declared variable referenced in this props block.
    const props = propsBlock(source, match.index + match[0].length)
    for (const [name, entry] of declared) {
      if (name === key) continue
      const use = new RegExp(`(\\w+):\\s*[^,{}]*(?:\\{[^}]*)?\\b${name}\\b`).exec(props)
      if (use !== null) {
        edges.push({ from: name, to: key, prop: use[1], commented: commented || entry.commented })
      }
    }
  }

  const live = nodes.filter((node) => !node.commented)
  const commented = nodes.filter((node) => node.commented)
  console.log(`\n=== ${file} — ${live.length} live, ${commented.length} commented ===`)
  for (const node of live) console.log(`  ${node.key} : ${node.type} (${node.id})`)
  for (const edge of edges) console.log(`  ${edge.from} --${edge.prop}--> ${edge.to}${edge.commented ? '  [commented]' : ''}`)
  if (commented.length > 0) console.log(`  commented out: ${commented.map((n) => `${n.key}:${n.type}`).join(', ')}`)
}
