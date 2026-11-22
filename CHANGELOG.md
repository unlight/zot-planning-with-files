## [1.2.0](https://github.com/unlight/zot-planning-with-files/compare/v1.1.0...v1.2.0) (2026-11-22)

### Features

* Add branch-aware plan selection ([d45d856](https://github.com/unlight/zot-planning-with-files/commit/d45d8563c1e284df4a4da9764b455f2a3041b0e6))
* Add read-only plan status target ([21d78de](https://github.com/unlight/zot-planning-with-files/commit/21d78de2447b2078dd836f14aee37aa7615eee5b))
* Bundle the zot planning skill ([3989483](https://github.com/unlight/zot-planning-with-files/commit/39894835e45795cb15dfeb9707e2d17f12257149))
* Detect archived plans during selection ([4cdd345](https://github.com/unlight/zot-planning-with-files/commit/4cdd3453631362125d0ff891a2c8bb5c33f4ba46))
* Guard and atomically close plans ([350b79d](https://github.com/unlight/zot-planning-with-files/commit/350b79d374f13574541737bee5708168e4638ac1))
* Log plan selection and notifications ([62f5938](https://github.com/unlight/zot-planning-with-files/commit/62f59382fa7210f9ccb7c48126090fc0fc83d025))
* Make completed plans explicit and quiet ([c959fbd](https://github.com/unlight/zot-planning-with-files/commit/c959fbd1f29dfae43ac12956c966283887e9a685))

### Bug Fixes

* Preserve plan mode on atomic close ([3e4c0ae](https://github.com/unlight/zot-planning-with-files/commit/3e4c0ae2c923730df17ec2f842ab9df0a092a6ec))
* Remove noisy dangerous-command warning ([67647ac](https://github.com/unlight/zot-planning-with-files/commit/67647ac32b916aef707cea5b1a2e1439f9ec3e89))
* Treat unreadable plans as missing ([2e71b84](https://github.com/unlight/zot-planning-with-files/commit/2e71b847de18fb84dba4c781fbd25bb4299ecd79))

## [1.1.0](https://github.com/unlight/zot-planning-with-files/compare/v1.0.0...v1.1.0) (2026-11-16)

### Features

* Add /plan-close command ([cb8ee5f](https://github.com/unlight/zot-planning-with-files/commit/cb8ee5f1e2ebb3787e7cf7ee48c134cb9eb798b8))

### Bug Fixes

* Gate auto-continue on in-progress phases ([07c7c8e](https://github.com/unlight/zot-planning-with-files/commit/07c7c8e7b30b61e7c0b9e2f8f1447f72c104827c))

## 1.0.0 (2026-11-09)

### Features

* Add lifecycle hooks and protocol entrypoint ([4068f85](https://github.com/unlight/zot-planning-with-files/commit/4068f857d749cc25dc17f6456e42d5ffda9ced05))
* Add mode resolution and per-session state ([28bca9b](https://github.com/unlight/zot-planning-with-files/commit/28bca9b0c21e4f78425dedca33d4900893bdb203))
* Add pi-agent command handlers ([7eda32b](https://github.com/unlight/zot-planning-with-files/commit/7eda32b409b1d69031d6f958ddd8dc0eb00193a2))
* Add planning file templates ([fd3b2cc](https://github.com/unlight/zot-planning-with-files/commit/fd3b2cc108df3c3df13039defe0115bde87b0d21))
* Add pwf command aliases ([7cf02b3](https://github.com/unlight/zot-planning-with-files/commit/7cf02b39f5bc844d467d0c02d8a89d18c85a6a96))
* Bundle planning-with-files skill and templates ([e2ea3f4](https://github.com/unlight/zot-planning-with-files/commit/e2ea3f4d27b8125268b39fa990e96ce8f07168d7))
* Deduplicate identical notifications ([6b9eb57](https://github.com/unlight/zot-planning-with-files/commit/6b9eb57b7a5655fb730f27a15300e134e495d587))
* Resolve plans and verify SHA-256 attestation ([f20dcae](https://github.com/unlight/zot-planning-with-files/commit/f20dcae42a56e34320d6eb760dee0765a39ec8fc))

### Bug Fixes

* Scope planning ignores to the repository root ([6cde622](https://github.com/unlight/zot-planning-with-files/commit/6cde622275631ba699dcc9d445935ab141ea4f66))
