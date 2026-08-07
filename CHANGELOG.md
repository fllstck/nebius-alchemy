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
