# Changelog

## [1.2.0](https://github.com/atdr/homebridge-philipsair-platform/compare/v1.1.0...v1.2.0) (2026-08-19)


### Features

* **config:** add model typeahead with tested device suggestions ([#19](https://github.com/atdr/homebridge-philipsair-platform/issues/19)) ([20daa19](https://github.com/atdr/homebridge-philipsair-platform/commit/20daa19ddc078513d6d19a899dc2b27be9c597b0))
* **config:** explain the aioairctrl prerequisite and fix the config UI ([#57](https://github.com/atdr/homebridge-philipsair-platform/issues/57)) ([cdb828f](https://github.com/atdr/homebridge-philipsair-platform/commit/cdb828ffaea459228f255540ffed578b3d1ee635))
* invoke aioairctrl directly, fix runtime bugs, add tests and CI ([#3](https://github.com/atdr/homebridge-philipsair-platform/issues/3)) ([a9f8715](https://github.com/atdr/homebridge-philipsair-platform/commit/a9f8715ac9bee3c42d5e765eaf502c6b79df7292))
* **startup:** verify the aioairctrl install before setting up devices ([#56](https://github.com/atdr/homebridge-philipsair-platform/issues/56)) ([774f28a](https://github.com/atdr/homebridge-philipsair-platform/commit/774f28a03178fda11a5a7ac07864522d4cca7571))


### Bug Fixes

* **ac0850:** stop exposing controls the model has no register for ([#47](https://github.com/atdr/homebridge-philipsair-platform/issues/47)) ([deb2675](https://github.com/atdr/homebridge-philipsair-platform/commit/deb2675a21cd7d2da0a58b232eb90aa45f5c5e0d))
* **commands:** report a set command the CLI rejected ([#45](https://github.com/atdr/homebridge-philipsair-platform/issues/45)) ([2499b3d](https://github.com/atdr/homebridge-philipsair-platform/commit/2499b3d648bd9671cf286e4265f6f8c26c0ec315)), closes [#42](https://github.com/atdr/homebridge-philipsair-platform/issues/42)
* **commands:** treat an unreported key as no evidence ([#43](https://github.com/atdr/homebridge-philipsair-platform/issues/43)) ([4e8dfb3](https://github.com/atdr/homebridge-philipsair-platform/commit/4e8dfb3b4005e655cfa51d2f9875a625333a704c)), closes [#41](https://github.com/atdr/homebridge-philipsair-platform/issues/41)
* **commands:** verify set commands and retry lost writes ([#40](https://github.com/atdr/homebridge-philipsair-platform/issues/40)) ([6f50bb3](https://github.com/atdr/homebridge-philipsair-platform/commit/6f50bb3c9f6701b017cd261b40ea411180999be2)), closes [#37](https://github.com/atdr/homebridge-philipsair-platform/issues/37)
* **logging:** name a failed stop and rate-limit parse failures ([#54](https://github.com/atdr/homebridge-philipsair-platform/issues/54)) ([67b2f22](https://github.com/atdr/homebridge-philipsair-platform/commit/67b2f22db489ee8b8d5363185b6c7cdfafa4fb13)), closes [#33](https://github.com/atdr/homebridge-philipsair-platform/issues/33)
* **logging:** stop reporting aioairctrl's debug output as an error ([#53](https://github.com/atdr/homebridge-philipsair-platform/issues/53)) ([8bf1d11](https://github.com/atdr/homebridge-philipsair-platform/commit/8bf1d11e35e542a6a97606cf8205044a4ddf2cfb)), closes [#49](https://github.com/atdr/homebridge-philipsair-platform/issues/49)
* **polling:** refresh on a timer and demote the stall timeout ([#44](https://github.com/atdr/homebridge-philipsair-platform/issues/44)) ([046dc11](https://github.com/atdr/homebridge-philipsair-platform/commit/046dc11e1c189a49204a493ebeb1529f1f5ecbdf)), closes [#38](https://github.com/atdr/homebridge-philipsair-platform/issues/38)
* **polling:** stop treating a switched-off device as a fault ([#52](https://github.com/atdr/homebridge-philipsair-platform/issues/52)) ([d8db9a1](https://github.com/atdr/homebridge-philipsair-platform/commit/d8db9a1b51f9219466196f6182af297b9b393031)), closes [#48](https://github.com/atdr/homebridge-philipsair-platform/issues/48)
* **polling:** supervise the observe stream and report silent failures ([#30](https://github.com/atdr/homebridge-philipsair-platform/issues/30)) ([735324b](https://github.com/atdr/homebridge-philipsair-platform/commit/735324b9899fc69f966b25dabc6c8b79877e0416))
* security hardening from project security review ([#5](https://github.com/atdr/homebridge-philipsair-platform/issues/5)) ([9ce2128](https://github.com/atdr/homebridge-philipsair-platform/commit/9ce2128a010b24ae1ab565db237c0bf5f3f81f8b))

## [1.1.0](https://github.com/atdr/homebridge-philipsair-platform/compare/v1.0.2...v1.1.0) (2026-03-08)

### Features

* add support for AC0850

## [1.0.2](https://github.com/atdr/homebridge-philipsair-platform/compare/v1.0.1...v1.0.2) (2021-11-06)

### Bug Fixes

* minor bugfixes

## [1.0.1](https://github.com/atdr/homebridge-philipsair-platform/compare/v1.0.0...v1.0.1) (2021-11-06)

### Bug Fixes

* removed some unnecessary logs

## 1.0.0 (2021-11-06)

### Features

* initial release

---

The v1.0.x releases were published by the upstream [seydx/homebridge-philipsair-platform](https://github.com/seydx/homebridge-philipsair-platform) project, which this plugin is based on. Their commits are tagged in this repository so the compare links above resolve.
