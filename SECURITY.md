# Security policy

## Supported versions

Only the latest release receives security fixes. Releases are cut automatically from `main`, so the
current version on npm is always the supported one:

```bash
npm install -g @atdr/homebridge-philipsair-platform@latest
```

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues.**

Report them privately through GitHub Security Advisories, using the
[Report a vulnerability](https://github.com/atdr/homebridge-philipsair-platform/security/advisories/new)
form. That opens a private thread visible only to you and the maintainer.

Please include:

- The version of the plugin, Homebridge and Node you are running
- What an attacker can do, and what access they need to do it
- Steps to reproduce, or a proof of concept

You can expect an acknowledgement within a week. If the report is accepted, a fix and an advisory
will follow; if it is declined, you will get the reasoning.

## Scope

This plugin runs the third-party [`aioairctrl`](https://pypi.org/project/aioairctrl/) CLI as a child
process to talk to devices on the local network. Vulnerabilities in `aioairctrl` itself belong
[upstream](https://github.com/kongo09/aioairctrl); how this plugin invokes it, and what it does with
the output, belongs here.
