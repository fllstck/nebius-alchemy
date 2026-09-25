/**
 * Nebius Alchemy custom oxlint plugin.
 *
 * Enforces Effect best practices .
 *
 * Rules:
 *   - nebius/no-effect-catchallcause: bans Effect.catchAllCause (use catchTag/catch instead)
 *   - nebius/no-effect-ignore: bans *silent* Effect.ignore — a bare reference or a call without
 *     `log`; `Effect.ignore({ log, message })` is audible and allowed (use catch + log otherwise)
 *   - nebius/no-silent-error-swallow: bans an error handler whose body is `Effect.void` or
 *     `Effect.succeed([] | undefined | null)` — a failure must not read as "nothing there"
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
    //
    // Measured 2026-09-25: `catchAllCause` does not exist anywhere in the pinned
    // Effect (`4.0.0-rc.117` — `grep -rl catchAllCause node_modules/effect/dist`
    // finds nothing). It is the v3 name; v4 spells the capability `catchCause`,
    // which is deliberately NOT banned: catching a whole `Cause` is the right tool
    // for best-effort work (a destroy-path cleanup must not fail on a defect), and
    // `no-silent-error-swallow` plus the tests that assert on log lines are what
    // keep that honest. So this rule bans a *name*, not the capability — it can
    // only ever fire on code that would not compile, and is kept as a guard against
    // the v3 spelling reappearing. Pinned by a must-fail fixture in
    // `tests/tools/oxlint-plugin.test.ts`, which is also where that measurement lives.
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
    // Bans *silent* `Effect.ignore`.
    //
    // Two things this rule got wrong until R-05 (2026-09-25):
    //   1. It matched only `Effect.ignore(effect)` — a `CallExpression`. The form
    //      the repo actually writes is `.pipe(Effect.ignore)`, which passes the
    //      member by *reference*, so the rule was inert against its one real
    //      occurrence while configured `error`. It now runs on the
    //      `MemberExpression`, which covers both.
    //   2. `Effect.ignore` is not inherently silent: v4 takes an options object and
    //      `log` makes the discarded `Cause` — defects included — audible. That is
    //      the sanctioned "best effort: log and continue", so it is allowed rather
    //      than forced behind an `oxlint-disable` with a comment.
    'no-effect-ignore': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'Disallow silent Effect.ignore (use Effect.ignore({ log, message }) or catch + log instead)',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        return {
          MemberExpression(node) {
            if (node.computed === true) return
            if (node.property.type !== 'Identifier' || node.property.name !== 'ignore') return
            if (extractObjectName(node.object) !== 'Effect') return

            const call = node.parent
            if (call && call.type === 'CallExpression' && call.callee === node && ignoreLogsTheCause(call)) return

            context.report({
              node: node.property,
              message:
                "Do not use Effect.ignore: it discards the failure cause (defects included) silently. Log and continue with Effect.ignore({ log: 'Warn', message: … }), or catch and log the error.",
            })
          },
        }
      },
    },

    // ── no-silent-error-swallow ──────────────────────────────────────────
    // Bans an error handler that answers a failure with a *constant* — `Effect.void`, or
    // `Effect.succeed([] | undefined | null)`. The handler should log, narrow to the code it is
    // willing to treat as benign (`NOT_FOUND`), or raise a tagged error.
    //
    // The two shapes are the same defect seen from different sides, which is why they share a rule.
    // `Effect.void` discards the failure outright. `Effect.succeed([])` is worse: on a `read`/`list`
    // path it tells drift detection and `alchemy unsafe nuke` that the resource does not exist, so a
    // `PERMISSION_DENIED` (rotated key, narrowed IAM role) silently shrinks the set of things the
    // tool believes it owns. Found 2026-09-25: the rule matched only `Effect.void` — 0 occurrences in
    // the repo — while `Effect.succeed([])` sat in **32** places.
    //
    // Note: in arrow-function single-expression bodies both are *reference* expressions —
    // `Effect.void` is a `MemberExpression` and `Effect.succeed(…)` a `CallExpression` — so the body
    // is matched structurally rather than by looking for a call.
    'no-silent-error-swallow': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'Disallow constant error handlers (Effect.void, Effect.succeed([]|undefined|null)) — log, narrow to NOT_FOUND, or raise a tagged error',
          recommended: true,
        },
        schema: [],
      },
      create(context) {
        const MESSAGE =
          'Error handler answers a constant (`Effect.void` / `Effect.succeed([] | undefined | null)`), so a failure reads as "nothing there". Log it, narrow to the code that is genuinely benign (`Effect.catchTag("GrpcError", (e) => e.code === 5 ? … : Effect.fail(e))`), or raise a tagged error — and if the swallow is deliberate, say why with an oxlint-disable.'

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
                  message: MESSAGE,
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
                  message: MESSAGE,
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
                    message: MESSAGE,
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
 * Does an `Effect.ignore(...)` call pass `log`?
 *
 * `Effect.ignore` is overloaded on its first argument — `ignore(effectOrOptions?, options?)` — so
 * either slot may carry the options object that makes the discarded `Cause` audible.
 */
function ignoreLogsTheCause(call) {
  return call.arguments.some(
    (argument) =>
      argument.type === 'ObjectExpression' &&
      argument.properties.some(
        (property) =>
          property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === 'log',
      ),
  )
}

/**
 * Does the expression reference `Effect.void`?
 *
 * In a single-expression arrow body it is a `MemberExpression` (property access), not a call — which
 * is why `() => Effect.void` needs no `CallExpression` to find.
 */
function isEffectVoidRef(expr) {
  if (!expr || expr.type !== 'MemberExpression') return false
  return (
    expr.property.type === 'Identifier' &&
    expr.property.name === 'void' &&
    extractObjectName(expr.object) === 'Effect'
  )
}

/** Strip the wrappers that do not change what an expression evaluates to. */
function unwrap(expr) {
  let node = expr
  while (
    node &&
    (node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'ParenthesizedExpression')
  ) {
    node = node.expression
  }
  return node
}

/**
 * `Effect.succeed(<empty>)` — a handler that answers "nothing there".
 *
 * `[]`, `undefined` and `null` are the three written shapes; anything else carries information
 * (`succeed(0)`, `succeed('')`). Type assertions are unwrapped, because
 * `Effect.succeed([] as readonly X[])` is the same statement with a type on it — and that spelling is
 * what the call sites actually use.
 */
function isEffectSucceedEmptyRef(expr) {
  const node = unwrap(expr)
  if (!node || node.type !== 'CallExpression') return false

  const callee = node.callee
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed === true ||
    callee.property.type !== 'Identifier' ||
    callee.property.name !== 'succeed' ||
    extractObjectName(callee.object) !== 'Effect'
  ) {
    return false
  }

  const argument = unwrap(node.arguments[0])
  if (!argument) return false
  if (argument.type === 'ArrayExpression') return argument.elements.length === 0
  if (argument.type === 'Literal') return argument.value === null
  if (argument.type === 'Identifier') return argument.name === 'undefined'
  return false
}

/** Either constant-handler shape. */
function isSilentRef(expr) {
  return isEffectVoidRef(expr) || isEffectSucceedEmptyRef(expr)
}

/** Is this function body just a constant (`Effect.void`, `Effect.succeed([])`), however wrapped? */
function isSilentBody(body) {
  if (!body) return false

  // Single expression: `() => Effect.void`
  if (isSilentRef(body)) return true

  // Block with straight expression: `() => { Effect.void }`
  if (
    body.type === 'BlockStatement' &&
    body.body.length === 1 &&
    body.body[0].type === 'ExpressionStatement' &&
    isSilentRef(body.body[0].expression)
  ) {
    return true
  }

  // Block with return: `() => { return Effect.void }`
  if (
    body.type === 'BlockStatement' &&
    body.body.length === 1 &&
    body.body[0].type === 'ReturnStatement' &&
    body.body[0].argument &&
    isSilentRef(body.body[0].argument)
  ) {
    return true
  }

  return false
}

/** Is this a function expression whose body is a constant? */
function isSilentHandler(fn) {
  if (!fn) return false
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
    return false
  }
  return isSilentBody(fn.body)
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
