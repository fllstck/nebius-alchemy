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
