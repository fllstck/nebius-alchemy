/**
 * Nebius Alchemy custom oxlint plugin.
 *
 * Enforces Effect best practices .
 *
 * Rules:
 *   - nebius/no-effect-catchallcause: bans Effect.catchAllCause (use catchTag/catch instead)
 *   - nebius/no-effect-ignore: bans Effect.ignore (use catch + log instead)
 *   - nebius/no-silent-error-swallow: bans () => Effect.void as an error handler
 *   - nebius/no-disable-validation: bans disableValidation: true
 *   - nebius/no-alchemy-deepequal: bans alchemy/Diff's deepEqual in provider code
 *     (it is blind to int64s — use ResourceUtils.specDeepEqual)
 *
 * @type {import("eslint").ESLint.Plugin}
 */
const plugin = {
  meta: {
    name: 'nebius',
    version: '0.1.0',
  },
  rules: {
    // ── no-effect-catchallcause ────────────────────────────────────────────
    // Bans `Effect.catchAllCause` because it catches all causes including
    // defects and interruptions. Prefer `Effect.catchTag` or `Effect.catch`.
    'no-effect-catchallcause': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Disallow Effect.catchAllCause (use catchTag or catch instead)',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type === 'MemberExpression' &&
              node.callee.property.type === 'Identifier' &&
              node.callee.property.name === 'catchAllCause'
            ) {
              const objectName = extractObjectName(node.callee.object)
              if (objectName === 'Effect') {
                context.report({
                  node: node.callee.property,
                  message: 'Do not use Effect.catchAllCause. Use Effect.catchTag or Effect.catch instead.',
                })
              }
            }
          },
        }
      },
    },

    // ── no-effect-ignore ─────────────────────────────────────────────────
    // Bans `Effect.ignore` because it silently swallows errors.
    // Prefer catching and logging the error.
    'no-effect-ignore': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Disallow Effect.ignore (prefer catch + log instead of silently swallowing)',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type === 'MemberExpression' &&
              node.callee.property.type === 'Identifier' &&
              node.callee.property.name === 'ignore'
            ) {
              const objectName = extractObjectName(node.callee.object)
              if (objectName === 'Effect') {
                context.report({
                  node: node.callee.property,
                  message: 'Do not use Effect.ignore. Catch and log the error instead.',
                })
              }
            }
          },
        }
      },
    },

    // ── no-silent-error-swallow ──────────────────────────────────────────
    // Bans patterns like `Effect.catchTag("Foo", () => Effect.void)`
    // that silently swallow errors. The error handler should at least log.
    //
    // Note: In arrow function single-expression bodies, `Effect.void` is
    // a MemberExpression (property access), NOT a CallExpression.
    'no-silent-error-swallow': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Disallow () => Effect.void as error handler (error handlers should log, not silently swallow)',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        /**
         * Check if an expression node references Effect.void.
         * Effect.void in single-expression arrow bodies is a MemberExpression.
         */
        function isEffectVoidRef(expr) {
          if (!expr || expr.type !== 'MemberExpression') return false
          return (
            expr.property.type === 'Identifier' &&
            expr.property.name === 'void' &&
            extractObjectName(expr.object) === 'Effect'
          )
        }

        /**
         * Check if a function body is just `Effect.void` (however wrapped).
         */
        function isSilentEffectVoidBody(body) {
          if (!body) return false

          // Single expression: `() => Effect.void`
          if (isEffectVoidRef(body)) return true

          // Block with straight expression: `() => { Effect.void }`
          if (
            body.type === 'BlockStatement' &&
            body.body.length === 1 &&
            body.body[0].type === 'ExpressionStatement' &&
            isEffectVoidRef(body.body[0].expression)
          ) {
            return true
          }

          // Block with return: `() => { return Effect.void }`
          if (
            body.type === 'BlockStatement' &&
            body.body.length === 1 &&
            body.body[0].type === 'ReturnStatement' &&
            body.body[0].argument &&
            isEffectVoidRef(body.body[0].argument)
          ) {
            return true
          }

          return false
        }

        /**
         * Check if the node is a function expression whose body is Effect.void.
         */
        function isSilentHandler(fn) {
          if (!fn) return false
          if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
            return false
          }
          return isSilentEffectVoidBody(fn.body)
        }

        return {
          CallExpression(node) {
            // Check for Effect.catchTag(...)
            const isCatchTag =
              node.callee.type === 'MemberExpression' &&
              node.callee.property.type === 'Identifier' &&
              node.callee.property.name === 'catchTag' &&
              extractObjectName(node.callee.object) === 'Effect' &&
              node.arguments.length >= 2

            if (isCatchTag) {
              const handler = node.arguments[node.arguments.length - 1]
              if (isSilentHandler(handler)) {
                context.report({
                  node: handler,
                  message:
                    'Error handler should not silently swallow with Effect.void. Log the error or handle it explicitly.',
                })
                return
              }
            }

            // Check for Effect.catch(...)
            const isCatch =
              node.callee.type === 'MemberExpression' &&
              node.callee.property.type === 'Identifier' &&
              node.callee.property.name === 'catch' &&
              extractObjectName(node.callee.object) === 'Effect' &&
              node.arguments.length >= 1

            if (isCatch) {
              const handler = node.arguments[node.arguments.length - 1]
              if (isSilentHandler(handler)) {
                context.report({
                  node: handler,
                  message:
                    'Error handler should not silently swallow with Effect.void. Log the error or handle it explicitly.',
                })
                return
              }
            }

            // Also match .pipe(Effect.catchTag(...)) nested patterns
            if (
              node.callee.type === 'MemberExpression' &&
              node.callee.property.type === 'Identifier' &&
              (node.callee.property.name === 'catchTag' || node.callee.property.name === 'catch') &&
              node.arguments.length >= 1
            ) {
              const handler = node.arguments[node.arguments.length - 1]
              if (isSilentHandler(handler)) {
                const parentIsPipe =
                  node.parent &&
                  node.parent.type === 'CallExpression' &&
                  node.parent.callee.type === 'MemberExpression' &&
                  node.parent.callee.property.type === 'Identifier' &&
                  node.parent.callee.property.name === 'pipe'
                if (parentIsPipe) {
                  context.report({
                    node: handler,
                    message:
                      'Error handler should not silently swallow with Effect.void. Log the error or handle it explicitly.',
                  })
                }
              }
            }
          },
        }
      },
    },

    // ── no-alchemy-deepequal ──────────────────────────────────────────────
    // Bans `deepEqual` from `alchemy/Diff` in provider code.
    //
    // `deepEqual` canonicalizes non-plain objects (class instances) to
    // `undefined` on purpose — walking Effect/Layer/SDK objects is unsafe — and
    // `long`'s `Long` is one, so every int64 compares equal to every other:
    // `deepEqual(Long.fromNumber(2), Long.fromNumber(8)) === true` (pinned in
    // tests/resources/utilities.test.ts). A drift check written with it is
    // therefore blind to exactly the fields users change most — disk and
    // filesystem sizes, TTLs, quota limits, key rotation periods — and plans an
    // update that never fires. It also makes `deepEqual(liveLong, undefined)`
    // true, i.e. a live-only value looks equal to an absent one.
    //
    // Use `ResourceUtils.specDeepEqual`, which normalizes Longs to their decimal
    // string first and delegates the rest to `deepEqual`. See AGENTS.md
    // §"Resource provider patterns".
    'no-alchemy-deepequal': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow alchemy/Diff deepEqual in provider code (it is blind to int64s; use ResourceUtils.specDeepEqual)',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        // Bound by an `import … from 'alchemy/Diff'` in this file, so a local
        // `deepEqual` from anywhere else is not flagged.
        const diffNamespaces = new Set()
        const diffFunctions = new Set()

        return {
          ImportDeclaration(node) {
            if (node.source.value !== 'alchemy/Diff') return
            for (const specifier of node.specifiers) {
              if (specifier.local === undefined) continue
              if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
                diffNamespaces.add(specifier.local.name)
              } else if (
                specifier.imported !== undefined &&
                specifier.imported.type === 'Identifier' &&
                specifier.imported.name === 'deepEqual'
              ) {
                diffFunctions.add(specifier.local.name)
              }
            }
          },
          CallExpression(node) {
            const callee = node.callee
            const namespaceCall =
              callee.type === 'MemberExpression' &&
              callee.computed !== true &&
              callee.property.type === 'Identifier' &&
              callee.property.name === 'deepEqual' &&
              callee.object.type === 'Identifier' &&
              diffNamespaces.has(callee.object.name)
            const namedCall = callee.type === 'Identifier' && diffFunctions.has(callee.name)
            if (!namespaceCall && !namedCall) return
            context.report({
              node: callee,
              message:
                'Do not use deepEqual from alchemy/Diff on proto values: it canonicalizes every int64 (`Long`) to `undefined`, so two different sizes/TTLs/limits compare equal and the drift check never fires. Use ResourceUtils.specDeepEqual.',
            })
          },
        }
      },
    },

    // ── no-disable-validation ────────────────────────────────────────────
    // Bans `disableValidation: true` in objects (commonly used in Alchemy
    // provider configs to bypass schema validation).
    'no-disable-validation': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Disallow disableValidation: true (bypassing validation hides errors)',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        function checkProperty(prop) {
          if (
            prop.type === 'Property' &&
            prop.key.type === 'Identifier' &&
            prop.key.name === 'disableValidation' &&
            prop.value.type === 'Literal' &&
            prop.value.value === true
          ) {
            context.report({
              node: prop,
              message: 'Do not use disableValidation: true. Validation exists for a reason.',
            })
          }
        }

        return {
          Property: checkProperty,
        }
      },
    },
  },
}

/**
 * Extract the root object name from a member expression chain.
 * `Effect.catchAllCause` → "Effect"
 * `effect.pipe` → "effect" (not a match for our rules)
 */
function extractObjectName(node) {
  if (!node) return ''
  if (node.type === 'Identifier') {
    return node.name
  }
  if (node.type === 'MemberExpression') {
    return extractObjectName(node.object)
  }
  return ''
}

export default plugin
