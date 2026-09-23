## [0.9.1](https://github.com/fllstck/nebius-alchemy/compare/v0.9.0...v0.9.1) (2026-09-23)


### ⚠️ Upgrade notes

* **Coming from 0.8.x, read the 0.9.0 notes below first** — that release carries the
  breaking changes (seven attribute types, `transfer.source.nebius.accessKey`, `AuthPublicKey`
  RSA-4096, the security-rule match block). The same list is now in the README
  (§*Upgrading from 0.8.x*), because npm shows the README and not this file.
* **`alchemy` is now a peer dependency, pinned to the exact beta (`2.0.0-beta.79`).** It was a
  `dependencies` entry, which meant a consumer on a different alchemy beta silently got **two** copies —
  their CLI on theirs, this package's providers on ours, each with its own Effect instance. The peer
  makes that a loud `ERESOLVE … peer alchemy@\"2.0.0-beta.79\"` instead. Both installers satisfy it
  automatically (npm 7+ and bun both auto-install peers), and the README's install line names it too.
* **No TypeScript dependency or peer is declared any more.** The `>=6 <8` *optional* peer made
  `npm install` fail once `alchemy` was a root peer: alchemy's optional frontend chains (`octane`,
  `@xata.io/client`) pull TypeScript 5.x, and an optional peer is still validated when the package *is*
  present. Bring your own compiler — 6 or 7 is verified (6.0.3, 7.0.2).
* **This package no longer ships `@effect/sql-d1`, `@effect/sql-sqlite-do` or `@effect/vitest`.** They are
  **alchemy's** dependencies — on the Effect 4 line (`4.0.0-rc.115+`), which alchemy installs itself —
  while this package's copies pinned the **Effect 3** line (`^0.50.0` / `^0.30.0`). Every consumer
  therefore had *two* versions of each (`npm ls` showed both), and the 0.x copies peer-require
  `effect@^3.22.1` (via `@effect/experimental@0.61.1`), which npm reported as four
  `ERESOLVE overriding peer dependency` warnings on every install. If you relied on them arriving
  through this package, add them to your own project, matched to the Effect 4 line.

### Bug Fixes

* **deps:** drop the Effect-3 copies of `@effect/sql-d1`, `@effect/sql-sqlite-do` and `@effect/vitest` —
  an install is now one `@effect/*` line with no `ERESOLVE` warnings
* **deps:** declare `alchemy` as an exact peer instead of a dependency, so a version mismatch fails the
  install instead of silently duplicating it (and drop the `typescript` peer, which broke `npm install`
  as a result)
* **readme:** document the 0.9.0 consumer-visible changes where consumers actually look

## [0.9.0](https://github.com/fllstck/nebius-alchemy/compare/v0.8.3...v0.9.0) (2026-09-22)


### ⚠️ Upgrade notes

* **Seven attributes are strings, and are now typed as such.** `toFriendlyAttributes` merges the API's
  own JSON renderings, and ts-proto renders every int64 as a decimal *string* — so
  `FilesystemAttributes.{sizeGibibytes,blockSizeBytes}`, `DiskAttributes.{sizeGibibytes,blockSizeBytes}`,
  `DiskSnapshotAttributes.{contentSizeBytes,storageSizeBytes}` and
  `FederationCertificateAttributes.keySize` were declared `number` while the value was `"4096"`.
  Nothing changes at runtime; code doing arithmetic on them now fails to *compile* instead of silently
  concatenating. Wrap them in `Number(...)` (or `BigInt(...)`) where you need the value.
  `AuthPublicKeyAttributes.keySize` and `AccessKeyAttributes.keySize` stay numbers — the wire type
  there is int32, and the rule is per-field, not "all numbers are strings".
* **`Nebius.storage.v1.Transfer` now requires `source.nebius.accessKey`.** The proto marks it optional;
  the service does not — `Create` answered `3 INVALID_ARGUMENT: Invalid argument` for a Nebius source
  without it, for *every* stop condition (measured against the live API). A missing key is now a
  plan-time error naming the field, instead of an opaque apply-time failure.
* **`Nebius.iam.v1.AuthPublicKey.data` must be an RSA-4096 public key.** That is the only shape the
  service accepts: RSA-2048/3072 answer `Key doesn't fits to any supported algorithms`, and
  Ed25519/ECDSA answer `Invalid public key data: expected public key in PEM-format` — which is
  misleading, since those *are* valid PEM; the service only parses RSA. Validated at plan time now,
  with a message that says so (and a certificate is rejected with the command to export the key).
* **`Nebius.vpc.v1.SecurityRule` requires the match block its `direction` selects.**
  `SecurityRuleSpec` has no `direction` field at all — the API infers INGRESS/EGRESS from `ingress` vs
  `egress` — so `direction: 'INGRESS'` with neither block could not express its direction and was
  silently dropped. Declaring a direction without the matching block is a plan-time error.
* No other props or wire shapes changed; everything below is a behaviour fix.

### Bug Fixes

* **vpc:** stop re-writing resources the platform already agrees with. `network`/`subnet` compared the
  pool structs the API *materializes* (`{pools: [], useNetworkPools: true}`) against omitted props, and
  `pool` compared its CIDR blocks as a whole array while the API fills each block's `state` and
  `maxMaskLength` — so every reconcile issued an update, and a create spent two writes. Comparisons are
  now guarded on the props you actually pinned, `subnet.routeTableId` included, which also stops a
  pinned route table from being reset when the prop is later removed from your config
  ([81fd829](https://github.com/fllstck/nebius-alchemy/commit/81fd829bf2ef43baf26ac18a78beb09e0baf0714), [b1f3eac](https://github.com/fllstck/nebius-alchemy/commit/b1f3eac4b1a5f746d8cdcbb6fedb1bf7c34b8bd9)).
* **vpc:** a security rule can no longer declare a direction it cannot express ([8af6162](https://github.com/fllstck/nebius-alchemy/commit/8af6162fb75887cd2207736837e4d99012d63639)).
* **storage:** the `Transfer`'s `stopCondition` never reached the wire. The proto models it as three flat
  oneof fields (`afterOneIteration`, `afterNEmptyIterations`, `infinite`) with no `stopCondition`
  message, so `fromJSON` dropped the union silently and the transfer ran with the server's default stop
  behaviour on create *and* update. The mapping is explicit now; the destination/source are compared by
  value instead of by reference (an unchanged config used to plan a replace and fail with
  `ALREADY_EXISTS`); and the platform's echoed credentials, limiters and iteration interval no longer
  read as drift ([cb96e3e](https://github.com/fllstck/nebius-alchemy/commit/cb96e3ea31fe1c375ec45e8c137b958e00704f2c)).
* **iam:** `AuthPublicKey` and `FederationCertificate` compared their whole spec, and the API does not
  echo a PEM verbatim — it terminates it (799 → 800 and 1240 → 1241 bytes measured), so both wrote an
  update on every reconcile. Only mutable fields are compared now, and a change to the immutable
  `FederationCertificate.data` plans a replace instead of being dropped ([1bc3817](https://github.com/fllstck/nebius-alchemy/commit/1bc3817828321228a1b38475c7b61bb6e7af13b7), [31b34b3](https://github.com/fllstck/nebius-alchemy/commit/31b34b38ddef888183642418d8d1387edd9508ab)).
* **iam:** `StaticKey` is created in `reconcile`, not `precreate`, so it can be declared in the same
  deploy as its service account. `precreate` receives raw props — references unresolved — and answered
  `PropsValidationError: Expected string at ["serviceAccountId"]`; the half-written state row it left
  behind then blocked the whole destroy plan ([9240a6b](https://github.com/fllstck/nebius-alchemy/commit/9240a6b1c014dc5213fc621906b101006b7e5c7f)).
* **resources:** every user-facing prop is now either planned by `diff`, reconciled in place, or
  explicitly declared non-converging. The sweep that established this (all 38 resources) found props
  that reached neither a plan nor a write, losing the change silently — `record.relativeName` (now a
  replace) and `transfer.stopCondition` above among them ([41db874](https://github.com/fllstck/nebius-alchemy/commit/41db874ee6ba16069d0292bfaeba4ef44a4abe6a), [0f9c350](https://github.com/fllstck/nebius-alchemy/commit/0f9c350bd003124aa2c4334c6ab643d198fa80d0)).
* **resources:** delete progress is narrated only when a re-issue will actually happen ([d8782e3](https://github.com/fllstck/nebius-alchemy/commit/d8782e3c774ea66b86cfa78cd25af73b05a6975b)).
* **compute:** the boot-disk image check inspects only the boot disk ([11482a0](https://github.com/fllstck/nebius-alchemy/commit/11482a098998d05f97522448cdd46f6ea9013395)).

### Tooling & tests

* **Mutation testing covers eight modules and runs nightly.** Aggregate **91.8 %**: `AuthProvider`
  65 % → **92.8 %**, `oauth` **90.2 %**, `Credentials` **100 %**. The nightly workflow writes a per-file
  table *and* every surviving mutant's source line into the run's Summary panel — a score alone is not
  actionable ([6d5c08a](https://github.com/fllstck/nebius-alchemy/commit/6d5c08ad0f2b7f5e72c7634d869ad292e7aa4723), [a50c2bb](https://github.com/fllstck/nebius-alchemy/commit/a50c2bbe7bda6d3b612483cafa8793e3ab310851), [66bab1b](https://github.com/fllstck/nebius-alchemy/commit/66bab1b94100444e0770853a217bf8e287ed8f28)).
* **The auth flows have doubles at last**: the OAuth token exchange (`fetch` seam), the loopback
  callback server as a real local listener, and the tenant/project pickers moved onto the `SaBootstrap`
  service — reaching them by `import` is what had made the OAuth login flow impossible to test
  ([0199686](https://github.com/fllstck/nebius-alchemy/commit/0199686ca4ced6f8b05eeaaf2a66177ed958704d)).
* Behavioural tests for the gRPC layer ([eb3ee48](https://github.com/fllstck/nebius-alchemy/commit/eb3ee4892395f6fd8b890149c2fa674c7e94623f)) and boundary tests for the shared validation filters
  ([07d6f40](https://github.com/fllstck/nebius-alchemy/commit/07d6f406cc69bc80534579f1ceeec64cc370e1f4), [ebf5061](https://github.com/fllstck/nebius-alchemy/commit/ebf50610a2ab0a75412e1510b47cbe12712624bd)).

## [0.8.3](https://github.com/fllstck/nebius-alchemy/compare/v0.8.2...v0.8.3) (2026-09-21)


### ⚠️ Upgrade notes

* **A failed `delete` no longer looks like a delete that never finishes.** The delete lifecycles
  raced the real call against a "Still deleting …" progress ticker using `Effect.race`, which
  completes on the first *success* — so a delete that **failed** waited on the ticker, and a
  `destroy` could sit for 30+ minutes reporting progress while the actual error was hidden. It was
  never a stalled server operation. Failures now surface immediately, and a genuinely stalled
  attempt is re-issued (bounded) before failing with a `DeleteStalledError`.
* **A delete blocked by a resource that still exists now waits for it.** `9 FAILED_PRECONDITION`
  ("Can't delete network … if subnets exist", "Subnet … is used in network interfaces: …") is
  routine mid-destroy: a VM tears down for minutes after its own delete returns. Deletes retry
  every 20s (bounded) instead of failing the destroy outright.
  Verified on a real VM: the hosted-instance e2e teardown went from a 30-minute timeout to green
  in 517 s, with the wait engaging twice (subnet, then network).
* No props, types or wire behaviour changed — nothing to migrate.

### Bug Fixes

* **resources:** surface failed deletes and re-issue genuinely stalled ones ([2682c46](https://github.com/fllstck/nebius-alchemy/commit/2682c464cda61c91a6fc59817b404a605472d523))
* **resources:** wait out a live dependency instead of failing the delete ([8604c5b](https://github.com/fllstck/nebius-alchemy/commit/8604c5ba2300003fee429340ac1eff3017497e5c))
## [0.8.2](https://github.com/fllstck/nebius-alchemy/compare/v0.8.1...v0.8.2) (2026-09-21)


### ⚠️ Upgrade notes

* **`npm install` works again — 0.8.0 and 0.8.1 could not be installed by npm at all** when
  following the README's install line. A *required* `typescript` peer made npm install a compiler
  version of its own choosing, which cannot be satisfied next to alchemy's optional
  `typescript@^6` frontend chain (`ERESOLVE`). The peer is now **optional**: npm installs no
  compiler version, and you install TypeScript 6 or 7 in your own project. Both are verified
  (`6.0.3`, `7.0.2` compile the package). Bun consumers were never affected.
* **Dependency pins are unchanged from 0.8.1** (`effect` / `@effect/platform-{bun,node,node-shared}`
  all `4.0.0-rc.117`) — see the 0.8.1 notes below for why they move as one constellation.
* **The consumer smoke test now installs the README's exact line, including `alchemy`.** Omitting
  it is what let both npm failures ship: as a transitive dependency alchemy's optional chain is
  skipped, so the tested command resolved where the documented one did not.

### Bug Fixes

* **ci:** install the README's line including alchemy in the consumer smoke test ([a0d2b56](https://github.com/fllstck/nebius-alchemy/commit/a0d2b569c0cc03a7dd4f299df736c45e90fef52b))
* **deps:** make the typescript peer optional so the documented npm install resolves ([d2992f2](https://github.com/fllstck/nebius-alchemy/commit/d2992f24a4afb3ccdf209fe5ca4150dac0a3f212))
## [0.8.1](https://github.com/fllstck/nebius-alchemy/compare/v0.8.0...v0.8.1) (2026-09-21)


### ⚠️ Upgrade notes

* **Move the `@effect/*` constellation together.** The peers are now `4.0.0-rc.117` (was
  `rc.115`) for `effect`, `@effect/platform-bun`, `@effect/platform-node` and
  `@effect/platform-node-shared`. They are exact on purpose: `@effect/platform-node@rc.115`
  range-depends on the shared package, and bun resolves that caret *upward*, so a consumer left
  on rc.115 ends up with a mixed family (verified: nested `rc.117` copies alongside a root one).
* **`typescript` is now a range (`>=6 <8`) instead of `^7`.** With an exact `^7` peer, a plain
  `npm install @fllstck/nebius-alchemy` fails with `ERESOLVE` — alchemy's optional frontend
  chain peers on `typescript@^6`. **0.8.0 could not be installed with npm at all**; upgrade to
  0.8.1, or add `--legacy-peer-deps` while staying on 0.8.0. Bun consumers were unaffected.
* Everything else in this patch is internal: the dependency pins and the consumer smoke test.

### Bug Fixes

* **ci:** install exactly the documented dependency set in the consumer smoke test ([eeec399](https://github.com/fllstck/nebius-alchemy/commit/eeec3997cc6066510cc734d00ef275e1375432d7))
* **deps:** pin the Effect constellation to 4.0.0-rc.117 and widen the typescript peer ([87fbb65](https://github.com/fllstck/nebius-alchemy/commit/87fbb6535288db63387ff770ac1dc2f080ba87af))
# [0.8.0](https://github.com/fllstck/nebius-alchemy/compare/v0.7.0...v0.8.0) (2026-09-21)


### BREAKING CHANGES

* **ID-valued props and attributes are branded.** A raw string literal no longer typechecks where a
  resource ID is expected — pass the exported brand (`Nebius.iam.ServiceAccountId.make('serviceaccount-…')`)
  or the `id` from a resource output. Runtime behaviour is unchanged. ([51a69aa](https://github.com/fllstck/nebius-alchemy/commit/51a69aa7a), [16ab5a0](https://github.com/fllstck/nebius-alchemy/commit/16ab5a090))
* **Removed props that never did anything.** `vpc.SecurityRule.description` (the API has no such
  field), `iam.AccessPermit.name` and `iam.GroupMembership.name` (the API rejects `metadata.name`
  on both). Passing them was silently ignored — delete them from your stacks. ([d4bc99c](https://github.com/fllstck/nebius-alchemy/commit/d4bc99c07), [6ce19ee](https://github.com/fllstck/nebius-alchemy/commit/6ce19eec4))
* **Immutable-field changes now plan a replace instead of an update that wrote nothing.**
  The services behind `mysterybox.SecretVersion` (`description`, `payload`, `setPrimary`),
  `iam.GroupMembership` (`revokeAfterHours`) and `iam.AccessPermit` (`role`, `resourceId`) have no
  `Update` RPC, so a change to those fields recreates the resource — **its id changes**. Before this
  release such a change planned an update that wrote nothing and the change was silently lost.
  `mysterybox.SecretVersion.name` is also now honoured (it was ignored before) and needs no action.

### Bug Fixes

* **api-client:** omit pageSize in NVL InstanceGroup list requests ([ec3c0c6](https://github.com/fllstck/nebius-alchemy/commit/ec3c0c6e34118592307f70bd0c9e6997e421859e))
* **auth:** preserve gRPC status and details in bootstrap errors ([ab1be50](https://github.com/fllstck/nebius-alchemy/commit/ab1be50d3a026506746cfb70d763082592359cdd))
* **auth:** use reconfigureHint for non-refreshable Nebius OAuth tokens ([3ae9dc9](https://github.com/fllstck/nebius-alchemy/commit/3ae9dc9382d49b50bb2759e64105e8ac3682af13))
* **capacity:** handle empty fabric values in resource advice ([935fce4](https://github.com/fllstck/nebius-alchemy/commit/935fce48ca841e1fbe3a1fd41d50c5732c221974))
* **compute/instance:** replace on gpuCluster change with delete-first ordering ([02bb67f](https://github.com/fllstck/nebius-alchemy/commit/02bb67fd6f4393dab50d5c582fa2ad8a12b48191))
* **iam,mysterybox:** replace resources on immutable spec changes ([57d80ee](https://github.com/fllstck/nebius-alchemy/commit/57d80ee8dc394ee448f2554cf735c665d62317c8))
* **iam:** correct replace semantics for access permits and group memberships ([6ce19ee](https://github.com/fllstck/nebius-alchemy/commit/6ce19eec4f7df478301357cab66a95f864eb8436))
* **providers:** ensure every prop converges via diff, reconcile, or replace ([d4bc99c](https://github.com/fllstck/nebius-alchemy/commit/d4bc99c0772948ecace0711bec9ec9538a87bd76))
* **resources:** route spec-only replaces through Factory helpers ([d014e38](https://github.com/fllstck/nebius-alchemy/commit/d014e3853077027df1efae0e832e8307dd48c46c))


### Features

* **capacity:** add read-only ResourceAdvice action for fabric discovery ([1aee914](https://github.com/fllstck/nebius-alchemy/commit/1aee914dd9a3b1ca998335e19340e563fe36991e))
* **compute:** add GpuCluster and NVLInstanceGroup resources ([3453a19](https://github.com/fllstck/nebius-alchemy/commit/3453a19e776c099581bd251c557687958ec104a2))
* **compute:** verify GpuCluster against real infra and self-discover fabric ([1353e35](https://github.com/fllstck/nebius-alchemy/commit/1353e356cd3d36955cd73fb814afdbd4032f894d))
* **endpoints:** add new services and pin ts-proto generator ([27ddc7e](https://github.com/fllstck/nebius-alchemy/commit/27ddc7e3d202f599b7bcd17d1e65edb39b6b68ab))
# [0.7.0](https://github.com/fllstck/nebius-alchemy/compare/v0.6.0...v0.7.0) (2026-09-18)


* feat!: migrate to alchemy 2.0.0-beta.79 / effect 4.0.0-rc.115 ([013a009](https://github.com/fllstck/nebius-alchemy/commit/013a0090f0d75022f08db44bf1593a98dde01273))


### Bug Fixes

* **auth:** probe only environment variables whose presence implies usable credentials ([885a882](https://github.com/fllstck/nebius-alchemy/commit/885a882f804c9b403b6d3c4a487a4a7f5c9b026a))
* **auth:** resolve profile via currentProfileName and update tests for API changes ([54335e3](https://github.com/fllstck/nebius-alchemy/commit/54335e36288614aa5bdac3ee3f2e741ba98fa544))
* **auth:** stop NEBIUS_PROJECT_ID from shadowing the profile ([bd6adcd](https://github.com/fllstck/nebius-alchemy/commit/bd6adcd3587e6fc1f04fa344c5172cc1b6d88a1f))
* **bundle:** annotate module-scope gRPC helpers with @__PURE__ ([d5a80fe](https://github.com/fllstck/nebius-alchemy/commit/d5a80fe417083587bd3587fc43ed37e9a87f066c))
* **ci:** verify package imports at runtime, not just typecheck ([49580a3](https://github.com/fllstck/nebius-alchemy/commit/49580a3bfec8cab975ddc37c80f57721329529d0))
* **compute:** enforce Nebius boot disk minimum and network interface requirements ([505557a](https://github.com/fllstck/nebius-alchemy/commit/505557a7ad8d01490b2b7b6261caed960336cc33))
* **compute:** ensure unzip is installed before bun installer runs ([1177db8](https://github.com/fllstck/nebius-alchemy/commit/1177db8bede970d083a06d79711b974b7e5eb665))
* **compute:** export HOME before bun install in hosted user data ([bfac2c6](https://github.com/fllstck/nebius-alchemy/commit/bfac2c6a1399b3e7de933ab58cd019e05db8475e))
* **compute:** reject hosted instances with unwrapped entry at plan time ([81f7481](https://github.com/fllstck/nebius-alchemy/commit/81f7481eba701ad991c47390d259743329a0f166))
* **compute:** switch hosted user-data to cloud-config multipart format ([aaf05e6](https://github.com/fllstck/nebius-alchemy/commit/aaf05e6133b6641fe0108ad3bdb4ccf75240e85d))
* **compute:** unwrap Redacted env values and fix hosted instance diff ([3d785f9](https://github.com/fllstck/nebius-alchemy/commit/3d785f9c7b9a63dac95ab3cd15d01daa6be74d7c))
* **spikes:** update ai-bindings-bundle to in-house cloudflare rolldown plugin ([ce7f4cf](https://github.com/fllstck/nebius-alchemy/commit/ce7f4cf116f7dd64cd0fd14bc7a157f99f81ce9c))
* **storage:** set zero TTL on bucket delete and improve S3 cleanup resilience ([cc7ece4](https://github.com/fllstck/nebius-alchemy/commit/cc7ece43aa48bfbc8d8dd55785656f0305525e67))
* **tests:** combine SG/rules and instance into single deploy in minimal-online test ([89bf7f7](https://github.com/fllstck/nebius-alchemy/commit/89bf7f7dfc66e51266c01c19ab7e1dbcb1474a81))
* **tests:** tolerate async soft-deletes in post-destroy leak checks ([8992f62](https://github.com/fllstck/nebius-alchemy/commit/8992f62c49b122222bbb487c3a043cd4e2fb4f12))
* **tests:** use per-run token for managed disk names to avoid orphan collisions ([c099b26](https://github.com/fllstck/nebius-alchemy/commit/c099b269438c850b1e83d4b75cc4e48c641d3937))
* **vpc:** apply platform defaults to security rule spec to prevent drift ([dcf1ec4](https://github.com/fllstck/nebius-alchemy/commit/dcf1ec461fd785807beed18d3275c594b8b3168c))


### chore

* **deps:** bump effect to 4.0.0-rc.112 and alchemy to 2.0.0-beta.77 ([ed787ac](https://github.com/fllstck/nebius-alchemy/commit/ed787ac44a1be3f5f7491e6e0113b10c4abf8606))


### Features

* **ai:** support instance hosts for ChatCompletions env bindings ([db91e43](https://github.com/fllstck/nebius-alchemy/commit/db91e432c1f117f281d3e2bcb468fa6a0f013038))
* **api-client:** add minimal online integration test for compute instances ([d207efe](https://github.com/fllstck/nebius-alchemy/commit/d207efe92ab55fa24708c62e958e39d7f9383670))
* **auth:** add schema validation and provider metadata for Nebius auth ([f66d89a](https://github.com/fllstck/nebius-alchemy/commit/f66d89a9f91aa86ef4c4a927fe9c181709e38372))
* **auth:** capture tenant ID during SA-key bootstrap ([3156f2b](https://github.com/fllstck/nebius-alchemy/commit/3156f2b34d815a87e0a065eca959316837e1adcd))
* **auth:** deactivate SA-key server-side on logout ([7f7bca4](https://github.com/fllstck/nebius-alchemy/commit/7f7bca43d1538bf85b953f0ad1596b2333d610f1))
* **auth:** replace SA grant confirmation with role selection ([443b0f8](https://github.com/fllstck/nebius-alchemy/commit/443b0f81ed4626b355ad3d4fb35431b2aefae113))
* **auth:** secure credential file permissions with chmod 0600 ([d5d1568](https://github.com/fllstck/nebius-alchemy/commit/d5d1568e70b171ac5cb91a30a025434c14a376b1))
* **auth:** support custom OAuth client id via environment variable ([688fa8e](https://github.com/fllstck/nebius-alchemy/commit/688fa8eeb1a1d0ad78a34441f2eefab34b5889b9))
* **compute:** add hosted runtime props to instance schema ([c4b2f55](https://github.com/fllstck/nebius-alchemy/commit/c4b2f55397bdd22c257a5270d47103eb175ca5de))
* **compute:** add hosted runtime support to Nebius Instance resource ([dd6a26f](https://github.com/fllstck/nebius-alchemy/commit/dd6a26f2f15a8249e25ec6c003551eb535e295fd))
* **compute:** add Nebius hosted runtime support for Instance ([09b14bd](https://github.com/fllstck/nebius-alchemy/commit/09b14bd95d1515a46a7b4b39e3a92a6535e52100))
* **compute:** expose disk snapshot source and encryption config ([614adec](https://github.com/fllstck/nebius-alchemy/commit/614adec17d223357e9941f5ff139c7fadf2404c3))
* **compute:** require boot disk image and validate props at plan time ([de673d2](https://github.com/fllstck/nebius-alchemy/commit/de673d2cd6c4a1dbc2cd93ce4ab9e652a9346ddb))
* **dns:** implement zone-scoped record listing for nuke support ([696e7db](https://github.com/fllstck/nebius-alchemy/commit/696e7db23d51b5b877b7bf4c34f0ddcf9b3c5c3c))
* **examples:** default ai-chat-instance to cheap CPU endpoint ([d172288](https://github.com/fllstck/nebius-alchemy/commit/d1722886f179176cd4495e4a96ec6ca691b056ef))
* **examples:** stream AI chat completions as SSE via `&stream=1` ([2ae9722](https://github.com/fllstck/nebius-alchemy/commit/2ae9722ccc4fe927134fc05f96dea7f64fc50728))
* **iam:** add list support and nuke ordering for IAM sub-resources ([e26fe8d](https://github.com/fllstck/nebius-alchemy/commit/e26fe8de90b621083f8a5587c713af5168b3b3d6))
* **resources:** expose the remaining Task 7b spec fields ([7cc2195](https://github.com/fllstck/nebius-alchemy/commit/7cc2195bb0172acf4f4601c5b26835fda8164dd3))
* **resources:** validate props at plan time in diff handlers ([eb5688b](https://github.com/fllstck/nebius-alchemy/commit/eb5688b242297e49693b50d6b1f3b11eb9645049))
* **resources:** validate props during plan-time read for all resources ([0576008](https://github.com/fllstck/nebius-alchemy/commit/0576008a57d0fa445dde3b99418ed9446a4a16df))
* **spikes:** add Nebius auth-registration entrypoint for first-run bootstrap ([35f4a6a](https://github.com/fllstck/nebius-alchemy/commit/35f4a6a6c2ea93cad16833add9a84ef05c63464a))


### Reverts

* **spikes:** drop the auth-registration workaround — the bug it worked around is fixed ([5c36e43](https://github.com/fllstck/nebius-alchemy/commit/5c36e43feb996a5d1ae8f529e46baaa5220e5458))


### BREAKING CHANGES

* requires alchemy@2.0.0-beta.79 and effect@4.0.0-rc.115 (exact peers). rc.112 and
rc.115 are mutually incompatible in both directions — rc.112's `Config.string`
does not exist in rc.115, and rc.115's `Config.String` does not exist in rc.112.
Consumers must move both together. No consumer `overrides` block is needed for
npm or bun.
* **compute:** hosted-instance child resources are now namespaced under the
instance's logical id, so their FQNs changed. An existing deployment does not
adopt the previous children: the next deploy creates them under the new FQNs and
destroys the old ones. This removes FQN collisions with user resources in the same
stack.
* **deps:** requires alchemy@2.0.0-beta.77 with effect@4.0.0-rc.112
(peer range >=4.0.0-rc.112 <4.0.0-rc.113); Effect and Alchemy must move together.
# [0.6.0](https://github.com/fllstck/nebius-alchemy/compare/v0.5.1...v0.6.0) (2026-08-10)


### Bug Fixes

* **auth:** always re-run OAuth flow during configure ([57facc3](https://github.com/fllstck/nebius-alchemy/commit/57facc32b621f0c468476825df381ffafe2d2dc3))
* **auth:** document RSA-4096 requirement for authorized keys ([5ca4326](https://github.com/fllstck/nebius-alchemy/commit/5ca4326122126b648ec49eaa4b2460674ec5e957))
* **auth:** redirect OAuth callback to Alchemy landing pages ([0826484](https://github.com/fllstck/nebius-alchemy/commit/082648444ed3caaff907012f7d73d20fa02b03f4))
* **provider:** reorder NebiusAuth merge before its dependencies ([ae96206](https://github.com/fllstck/nebius-alchemy/commit/ae96206cdbc29c09dc10c9fec8cd02f75aafe771))


### Features

* **auth:** add browser-based OAuth login for Nebius ([ffda300](https://github.com/fllstck/nebius-alchemy/commit/ffda300ce98e9284c9154dac51013365e017bcc7))
* **auth:** add SA-key bootstrap and harden CLI token flow ([f58af9f](https://github.com/fllstck/nebius-alchemy/commit/f58af9f53f722d093f80a96d383fffe35bcde8f4))
* **auth:** add service-account key authentication for Nebius ([30a7fad](https://github.com/fllstck/nebius-alchemy/commit/30a7fad357d56dccbd6bc30000f71fad071e8d3b))
* **auth:** detect project mismatch for stored SA keys ([b0ca6c6](https://github.com/fllstck/nebius-alchemy/commit/b0ca6c66677e8f31f4befc1cc3147a4be548a0f0))
* **auth:** remove nebius-cli auth method and use OAuth for SA bootstrap ([6e15212](https://github.com/fllstck/nebius-alchemy/commit/6e15212a4515b44db5953dc60d9a5cf367f32aa0))
* **auth:** resolve tenant from OAuth token instead of env var ([306e479](https://github.com/fllstck/nebius-alchemy/commit/306e4797c70c7ca1ec71edd5f5a11d880c22b56b))
* **auth:** show project name in SA grant confirmation prompt ([3e615c5](https://github.com/fllstck/nebius-alchemy/commit/3e615c519ec4a69c5a6d63afec62de5cfe3590d6))
### ⚠️ Breaking Changes

* **auth:** remove the `nebius-cli` auth method — browser OAuth (`oauth`) and service-account keys (`sa-key`) replace it; stored `nebius-cli` profiles must re-run `alchemy login` (migration guard added) ([6e15212](https://github.com/fllstck/nebius-alchemy/commit/6e15212a4515b44db5953dc60d9a5cf367f32aa0))

## [0.5.1](https://github.com/fllstck/nebius-alchemy/compare/v0.5.0...v0.5.1) (2026-08-07)


### Bug Fixes

* **ai:** enforce 64 GiB disk floor and fail fast on instance errors ([e91a994](https://github.com/fllstck/nebius-alchemy/commit/e91a994b7203e5d3b2145b48acea474323e3b4b3))
# [0.5.0](https://github.com/fllstck/nebius-alchemy/compare/v0.4.2...v0.5.0) (2026-08-07)


### Bug Fixes

* **ai:** await RUNNING for fresh endpoint creates to fix deploy-time env eval ([e8e6fcd](https://github.com/fllstck/nebius-alchemy/commit/e8e6fcd7f692eda8fd2bf60aa35f306193e70c08))
* **ai:** make endpoint env derivation lenient and fail fast on ERROR state ([2dac0ba](https://github.com/fllstck/nebius-alchemy/commit/2dac0ba5a4c3c9706c0f746fb688fe4c02f0eb2e))
* **ai:** prefer https tunnel URL over raw IP:port for endpoint ([90f1b9a](https://github.com/fllstck/nebius-alchemy/commit/90f1b9a82ef8256dc6a0f13e8ef807562462c0a5))
* **bindings:** force secret_text for worker env bindings ([287cd56](https://github.com/fllstck/nebius-alchemy/commit/287cd56d1a3fbbb5f8abef413ad676cdffa18890))
* **modules:** guard all resource providers with __ALCHEMY_RUNTIME__ DCE guard ([1b9c721](https://github.com/fllstck/nebius-alchemy/commit/1b9c72138b5e1d4c1db9e29bbfd99e0bc43eac18))


### Features

* **ai/endpoint:** persist authToken in endpoint attributes ([1449cf2](https://github.com/fllstck/nebius-alchemy/commit/1449cf21ce4ccd3c9e46c99cf8603487389e1951))
* **ai:** add deploy-time endpoint env wiring and ChatCompletions layer ([35a0c8c](https://github.com/fllstck/nebius-alchemy/commit/35a0c8c9e60c882fdac8a40bf9d617f6cf964a88))
* **ai:** add OpenAI-compatible wire schemas and SSE parser for AI bindings ([2286773](https://github.com/fllstck/nebius-alchemy/commit/2286773d7e6979f021e54b71b6ad45ead1813cc3))
* **ai:** add typed error handling and runtime client for chat completions ([e489b19](https://github.com/fllstck/nebius-alchemy/commit/e489b19ccca88c787d9eddd030d7a9d5ebd0ecd5))
* **ai:** surface endpoint provisioning progress in session notes ([eb2cb3d](https://github.com/fllstck/nebius-alchemy/commit/eb2cb3dacf01d1b3122d1ce272011aa106b3c11e))
## [0.4.2](https://github.com/fllstck/nebius-alchemy/compare/v0.4.1...v0.4.2) (2026-08-07)
## [0.4.1](https://github.com/fllstck/nebius-alchemy/compare/v0.4.0...v0.4.1) (2026-08-07)


### Bug Fixes

* **api-client:** derive polling attempt cap from deadline window ([afe6c8b](https://github.com/fllstck/nebius-alchemy/commit/afe6c8b953b123febe6a23ebd1040f3ab1312639))
* **api-client:** increase operation polling deadlines for VM-backed services ([38ea122](https://github.com/fllstck/nebius-alchemy/commit/38ea1224b3026c512fe6394b8a2993aecb8c5540))
* **ci:** regenerate schemas before typecheck and tests ([33567a5](https://github.com/fllstck/nebius-alchemy/commit/33567a57275b7db88b83529bc64885cae674a1aa))
* **tests:** update job state enum to match Nebius lifecycle ([ff6e884](https://github.com/fllstck/nebius-alchemy/commit/ff6e8845a959b20ce8b8f0d3a2ca404bd9d284c0))
* **tests:** use provideMerge for config layer in factory tests ([723fe25](https://github.com/fllstck/nebius-alchemy/commit/723fe255052c46af4d88f756b82a5016c32bddee))
# [0.4.0](https://github.com/fllstck/nebius-alchemy/compare/v0.3.15...v0.4.0) (2026-08-06)


* refactor(storage)!: rename CF binding layers to *Http naming ([742d2e8](https://github.com/fllstck/nebius-alchemy/commit/742d2e89ee9d861ac63496b463ec62207001d1f4))


### Bug Fixes

* **ai:** make disk required for job and endpoint schemas ([b6d683a](https://github.com/fllstck/nebius-alchemy/commit/b6d683a29ce1928d6118912553ae3a7af0cd86fb))
* **api-client:** add idempotency key and fix group membership metadata ([9faf30d](https://github.com/fllstck/nebius-alchemy/commit/9faf30d42f65b776808c914bf6fc1e9b7cedc984))
* **api-client:** add idempotency key to gRPC requests ([77f2eee](https://github.com/fllstck/nebius-alchemy/commit/77f2eee12b442d33c96ddb47e2941588ef9f2324))
* **api-client:** spoof grpc-go user agent for endpoint routing ([5782f39](https://github.com/fllstck/nebius-alchemy/commit/5782f39b1bfe5ccf4bf4eefaceaefe9d8ebb56c6))
* **docs:** update BINDINGS.md with production verification findings ([db7b641](https://github.com/fllstck/nebius-alchemy/commit/db7b641e0409a881d2a91eabd72a314fd4e82683))
* **examples:** resolve worker path relative to stack file ([a826d9d](https://github.com/fllstck/nebius-alchemy/commit/a826d9d377076bb560b53864164d431b895bca21))
* **iam:** harden group membership retry and clean up integration findings ([53fae10](https://github.com/fllstck/nebius-alchemy/commit/53fae10b3f6466e2390378ad1730edb9d346aad9))
* **iam:** omit metadata.name on AccessPermit creates ([d8a80dd](https://github.com/fllstck/nebius-alchemy/commit/d8a80ddadb71a81b019ebcac6c579bca6e86d628))
* **iam:** retry access key creation on NOT_FOUND and update docs ([4062201](https://github.com/fllstck/nebius-alchemy/commit/40622018b39fa9269c198243988e20123b86afbd))
* **iam:** retry access key creation on transient SA not found errors ([77d84e3](https://github.com/fllstck/nebius-alchemy/commit/77d84e34a6807c1a38001c4fa9774300c7be18f6))
* **resources:** make deletes idempotent and fix integration test pattern ([81c016b](https://github.com/fllstck/nebius-alchemy/commit/81c016baa20461a3134cfeb9f839cb85d83241d9))
* **storage:** deduplicate shared host-identity env bindings across capabilities ([1775860](https://github.com/fllstck/nebius-alchemy/commit/17758601f189da0b4657da85d00ddf1be56ff41a))


### Features

* **bindings:** add cross-cloud typed clients for Nebius resources ([8bcaaec](https://github.com/fllstck/nebius-alchemy/commit/8bcaaecc9b2f2cac47f4eaf1b0352caba5b0141b))
* **bindings:** fix deploy-time wiring and add mocked-host e2e test ([7d0d204](https://github.com/fllstck/nebius-alchemy/commit/7d0d2040cbe024a463a3a379f7a0b1c5cc8737ff))
* **examples:** add typed Nebius S3 bindings example for Cloudflare Workers ([475f62c](https://github.com/fllstck/nebius-alchemy/commit/475f62c63fd58342404d9663c07d6453dffd952e))
* **examples:** extract bindings worker into separate entry file ([db72b21](https://github.com/fllstck/nebius-alchemy/commit/db72b21ab92d2bae93f690c7be45d0f8a0f5738b))
* **iam:** omit metadata.name on AccessPermit creates and preserve Redacted in bindings ([b64c94e](https://github.com/fllstck/nebius-alchemy/commit/b64c94e50445d957a7123ff2e2c5b72977e20c9f))
* **provider:** add AI Job and Endpoint resources ([c08e21a](https://github.com/fllstck/nebius-alchemy/commit/c08e21afe5453073dd9cfb296726aa54cbefc188))
* **resources:** implement M1 worker host wiring core ([664191a](https://github.com/fllstck/nebius-alchemy/commit/664191abb6681d3c06a5ddd08bbd31039fd5eddd))
* **resources:** support Output expressions in Worker env bindings ([527d1cd](https://github.com/fllstck/nebius-alchemy/commit/527d1cd2f5949f464aa876056eb0b69bbe087d4a))
* **storage:** add wireAsyncBindings helper for async workers ([3475733](https://github.com/fllstck/nebius-alchemy/commit/34757330f3346e4d36859e2d3912d909213e2e44))
* **storage:** implement M2 storage bindings with S3 client and tagged errors ([e80465f](https://github.com/fllstck/nebius-alchemy/commit/e80465fa2c20e20469f5b8a29b941a7931ff6a0b))
* **tests:** add post-destroy leak verification to integration tests ([637362f](https://github.com/fllstck/nebius-alchemy/commit/637362f7fac3a0869c3398461528619587d569b4))


### Performance Improvements

* **tests:** defer heavy package import with shared test stack helper ([47fc9f6](https://github.com/fllstck/nebius-alchemy/commit/47fc9f65d1c698a55c58e10f3c2dbb9b369d5100))


### BREAKING CHANGES

* GetObjectBinding/PutObjectBinding renamed to GetObjectHttp/PutObjectHttp (alchemy HTTP-backed naming convention); the AWS arm reserves FunctionHttp layers.
