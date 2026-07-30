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
