<p align="center">
    <img src="https://raw.githubusercontent.com/atdr/homebridge-philipsair-platform/main/images/logo.png" alt="Plugin logo" height="200">
</p>

# homebridge-philipsair-platform

[![npm](https://img.shields.io/npm/v/@atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://www.npmjs.com/package/@atdr/homebridge-philipsair-platform)
[![npm](https://img.shields.io/npm/dt/@atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://www.npmjs.com/package/@atdr/homebridge-philipsair-platform)
[![GitHub last commit](https://img.shields.io/github/last-commit/atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://github.com/atdr/homebridge-philipsair-platform)
[![CI](https://img.shields.io/github/actions/workflow/status/atdr/homebridge-philipsair-platform/ci.yml?style=flat-square&label=CI)](https://github.com/atdr/homebridge-philipsair-platform/actions/workflows/ci.yml)

A [Homebridge](https://homebridge.io) plugin that brings Philips air purifiers and humidifiers into Apple Home. It talks to the device directly on your own network, over the encrypted CoAP protocol the purifiers use, with no Philips account and no cloud service in the path.

In the Home app you get:

- An **air purifier** with power, fan speed, air quality and filter status
- An optional separate **humidifier** accessory
- Optional **temperature** and **humidity** sensors
- The device's own **lights** as lightbulbs

Not every model exposes every control. The AC0850, for example, reports no auto/manual mode and no child lock, so neither is offered in the Home app for that model; power, fan speed, air quality and filter status are unaffected.

## Requirements

- **Homebridge** `^1.8` or `^2.0`
- **Node** `^20.18`, `^22.10`, or `^24`
- **Python 3.12+** and the [`aioairctrl`](https://pypi.org/project/aioairctrl/) CLI, installed for the user that runs Homebridge. Device communication is not pure JavaScript: the plugin runs this command to speak the purifiers' protocol, and it is not installed automatically.
- A Philips purifier on the same network, at an address that does not change

## Quick start

### 1. Install aioairctrl

```bash
pipx install aioairctrl
sudo -u homebridge aioairctrl --help
```

The second command is the one that matters: the CLI has to run as the account Homebridge runs as, not just as you. The plugin runs the same check itself at startup and says what to fix in the log if it cannot run the command.

<details>
<summary>Other platforms, other install methods, and what to do if it is not on the PATH</summary>

On macOS, `brew install pipx`. On Windows, install Python from [python.org](https://www.python.org/downloads/) and then `py -m pip install --user pipx`. On Debian/Ubuntu, `sudo apt install python3 pipx` first.

Any install method works (`pip install --user`, a virtualenv, `sudo python3 -m pip install --break-system-packages aioairctrl`) as long as the `aioairctrl` command is available to the Homebridge user.

If the executable is not on that user's PATH, which is common with pipx because it installs to `~/.local/bin`, run `which aioairctrl` and put the full path it prints into the **aioairctrl Path** option, e.g. `/home/pi/.local/bin/aioairctrl`.

The latest `aioairctrl` needs Python 3.12 or newer; on older Python versions pip and pipx fall back to an older release. If startup reports a problem, see [Cannot run aioairctrl](#cannot-run-aioairctrl).

</details>

### 2. Install the plugin

Search for `philipsair` on the **Plugins** page of the [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x), or install it from the command line:

```bash
sudo npm install -g @atdr/homebridge-philipsair-platform@latest
```

### 3. Give the purifier a fixed address

The plugin reaches your device at the address you configure and never rediscovers it. If your router hands out addresses by DHCP, that address can change when the lease renews, and the accessory then stops responding with nothing in the log to explain why.

Set a **DHCP reservation** for the purifier on your router, sometimes called a static lease or an address reservation, and use the reserved address in the config. A hostname such as `purifier.local` works too, on a network that resolves it reliably.

### 4. Add the device in the Homebridge UI

Open the plugin's settings, add a device, and fill in **Model**, **Name** and **Host Address**. Everything else has a working default, and the UI explains each field as you go.

> [!IMPORTANT]
> **Model** and **Name** are not interchangeable. **Model** is the ID printed on the device (`AC0850`), and it selects the commands the plugin sends. **Name** is only your own label in the Home app (`Bedroom Purifier`). Putting the model ID in Name and leaving Model unset is the single most common configuration mistake with this plugin, and it leaves you with an accessory whose controls do nothing.

<details>
<summary>Finding your model ID</summary>

It is printed on the label on the back or underside of the unit, and shown in the Philips app. It looks like `AC0850/11`, and you enter only the part before the slash, `AC0850`. The suffix is a regional variant and is not part of the ID the plugin matches. Case and stray spaces do not matter.

</details>

<details>
<summary>Checking the device answers before you configure it</summary>

Confirm the purifier talks to this machine at all, using the address from step 3:

```bash
aioairctrl -H 10.0.1.16 -P 5683 status -J
```

Allow up to 90 seconds for a reply. These purifiers serve **one connection at a time**, so stop Homebridge first if it is already polling this device, and run the check with the purifier switched **on**. One that is switched off can legitimately stay silent for half an hour.

The keys it prints are the device's own status registers. The plugin translates them using the mapping selected by **Model**.

</details>

## Configuration

The Homebridge UI documents every field inline, so this section is a reference for editing `config.json` by hand.

### Platform options

| Option           | Description                                                                    | Default                |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------- |
| `platform`       | Must always be `PhilipsAirPlatform`. **Required.**                             | none                   |
| `name`           | Name for the log.                                                              | `"PhilipsAirPlatform"` |
| `aioairctrlPath` | Full path to the `aioairctrl` executable, if it is not on the PATH.            | _(PATH lookup)_        |
| `debug`          | Logs every device status and command. Very noisy; switch it off afterwards.    | `false`                |
| `cliDebug`       | Adds aioairctrl's own debug log to the plugin's.[^cli-debug]                   | `false`                |
| `warn`           | Reports problems the plugin recovered from, such as a lost command.            | `true`                 |
| `error`          | Reports the underlying error behind a problem.[^always-reported]               | `true`                 |
| `extendedError`  | Includes the full stack trace with each error. Useful when reporting an issue. | `true`                 |
| `devices`        | Array of the purifiers to expose, one entry each. **Required.**                | none                   |

### Device options

Each entry in the `devices` array is one purifier. Three fields are required:

| Option  | Description                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model` | The model ID printed on the device, without the regional suffix. Selects the command set the plugin sends, so see [Device support](#device-support). |
| `name`  | Your own label for the device in the Home app. Not the model ID.                                                                                     |
| `host`  | IP address or hostname of the device. Give it a fixed address first (Quick start, step 3).                                                           |

<details>
<summary>Optional device options</summary>

| Option            | Description                                                                                                                                                                            | Default     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `active`          | Set `false` to skip this device without deleting its configuration.                                                                                                                    | `true`      |
| `port`            | Port of your device.                                                                                                                                                                   | `5683`      |
| `refreshInterval` | Shortest wait after a reading before asking for another. `0` disables the refresh entirely. See [The state in the Home app is out of date](#the-state-in-the-home-app-is-out-of-date). | `60`        |
| `manufacturer`    | Shown in the Home app. Cosmetic only.                                                                                                                                                  | `"Philips"` |
| `serialNumber`    | Shown in the Home app. Cosmetic only.                                                                                                                                                  | `"000000"`  |
| `humidifier`      | Expose a separate humidifier accessory to HomeKit.                                                                                                                                     | `false`     |
| `light`           | Expose device lights as lightbulbs to HomeKit.                                                                                                                                         | `false`     |
| `temperature`     | Expose device temperature as a temperature sensor to HomeKit.                                                                                                                          | `false`     |
| `humidity`        | Expose device humidity as a humidity sensor to HomeKit.                                                                                                                                | `false`     |
| `sleepSpeed`      | Adds a 'sleep' step below the lowest fan speed.[^sleep-speed]                                                                                                                          | `false`     |
| `allergicFunc`    | Does this device support the 'allergic' function?                                                                                                                                      | `false`     |
| `preFilter`       | Expose pre-filter status to HomeKit.                                                                                                                                                   | `false`     |
| `carbonFilter`    | Expose active carbon filter status to HomeKit.                                                                                                                                         | `false`     |
| `hepaFilter`      | Expose HEPA/NanoProtect filter status to HomeKit.                                                                                                                                      | `false`     |

</details>

For a complete `config.json`, see [`example-config.json`](https://github.com/atdr/homebridge-philipsair-platform/blob/main/example-config.json) in the repository.

[^cli-debug]: Only has an effect while `debug` is on, and it is the noisier half of the two: on a tested AC0850 the CLI's own records were about three quarters of the log. Turn it on when the problem is `aioairctrl` itself, such as a Python install that never finishes a sync, and leave it off when the problem is a device.

[^always-reported]: Faults that stop the plugin working at all, such as an `aioairctrl` it cannot run, are always reported, whatever this is set to.

[^sleep-speed]: Ignored for models that have their own speed mapping. Those use the right speeds automatically, and the plugin warns when the option cannot do anything.

## Device support

The `model` field selects how the plugin encodes power, mode and fan speed, because Philips models do not agree on any of the three. Support falls into three tiers.

| Tier            | Tested                                                 | Mapped, unverified                                | Everything else                                |
| --------------- | ------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------- |
| **Description** | Dedicated mapping, verified on real hardware.          | Dedicated mapping, inherited and never confirmed. | Default mapping. Often fits, never guaranteed. |
| **Models**      | <ul><li>AC0850</li><li>AC1715</li><li>AC3036</li></ul> | <ul><li>AC3829</li></ul>                          | <ul><li>Any other model</li></ul>              |

The model dropdown in the Homebridge UI offers every model with a mapping of its own, tested or not. Anything else falls back to the default.

The symptom of a mapping that does not fit is an accessory that appears in the Home app with controls that do nothing. The plugin compares the first status a device sends against the mapping in force and reports a mismatch in the log, so it usually tells you when it has guessed wrong.

**To get your model added**, open a [model support request](https://github.com/atdr/homebridge-philipsair-platform/issues/new?template=model_support.yml) with a status dump from your device:

```bash
aioairctrl -H 10.0.1.16 -P 5683 status -J
```

That dump is what the mapping is derived from, so a request with one attached can usually be acted on straight away.

## Troubleshooting

Turn on **Debug Log** in the plugin settings in the Homebridge UI, or set `debug` to `true` in the platform block of `config.json`, then restart Homebridge and reproduce the problem. Switch it off again afterwards: it logs every status and every command, and it is very noisy.

[Symptoms](#symptoms) covers what you see in the Home app. [Log messages](#log-messages) covers what the plugin writes to the Homebridge log, one entry per message.

### Symptoms

#### The device appears in the Home app but none of its controls work

<details>
<summary>Almost always the model field. Three things to check.</summary>

The accessory is there, its tiles respond to taps, and the purifier ignores every one of them.

Philips models encode power, mode and fan speed differently, and the plugin picks the encoding from `model`. When that field is missing, misspelled, or holds a display name rather than an ID, the plugin falls back to a default mapping and sends commands your device has no registers for. Nothing reports an error: commands go out over an unacknowledged protocol and the device simply discards the ones it does not understand.

Check all three of these:

1. `model` holds the ID printed on the device, without the regional suffix. `AC0850/11` means `AC0850`. It is not a display name such as `Air Purifier` or `Bedroom`. Case and stray spaces do not matter, and the suffix is ignored.
2. The model ID is not sitting in `name` instead. `name` is only the label shown in the Home app. If the plugin finds a model ID it recognises there while `model` names nothing it recognises, it uses it anyway and warns, so the device works while the config is still wrong:

   ```text
   AC0850: "AC0850" in the device name looks like a model ID, and no model is configured. Using the AC0850 command set. Move it to the model field to silence this.
   ```

3. The log names the command set every device starts with. This line is the one to look for:

   ```text
   Bedroom: Using the AC0850 command set.
   ```

   A device that instead reports `No tested mapping for model "..."`, or `No model is configured`, is running on the default mapping. That is expected for a model outside the tested list, and a bug in your config if your model is on it.

The plugin also checks the config against the device itself. The first status a device sends is compared with the mapping in force, and one that answers in registers the mapping cannot read is reported:

```text
Bedroom: This device reports registers this model mapping does not know (D01102, D03102, D0310A, D0310C), and they match the AC0850 mapping. Its controls will not work until the model is set to AC0850 in the plugin config. Until then the AC0850 command set will be used from the next restart.
```

It remembers what it identified, so a device with no usable model configured picks up the right mapping by itself from the next restart, and says so each time it starts:

```text
Bedroom: Using the AC0850 command set instead of the default, detected from this device's own status on an earlier run.
```

Expect the Home app to change at the restart that adopts a model. A mapping knows which controls a model has no register for, so tiles the previous run offered can disappear. That is the plugin matching what the device can actually do, not a fault.

That is a fallback, not a fix. Setting `model` correctly is what makes the plugin get the device right on its first run, including which services it offers in the Home app.

If the model is right and the controls still do nothing, set `debug` to true, copy a logged status line, and open an issue with it.

</details>

#### The state in the Home app is out of date

<details>
<summary>These purifiers report on their own schedule. The refresh interval is a floor, not a cadence.</summary>

These purifiers report spontaneously only while their values are changing, so a device sitting idle can stay quiet for several minutes at a time. The plugin therefore asks for a fresh reading `refreshInterval` seconds after the last one, by re-subscribing, which is what prompts the device to answer.

A purifier that is switched **off** is a case of its own: some models answer only every few minutes, or not at all for half an hour, and nothing the plugin does makes them answer sooner. Its reported state stays `off` throughout, and the plugin stops asking so often rather than restarting and warning in a loop.

The interval is a floor rather than a fixed cadence. Re-subscribing is a trade: it prompts a reading, and on some devices it costs far more than simply waiting would have. On a tested AC0850 a subscription left alone was answered every 9 seconds, while a replacement one took 140 seconds at the median, so a fixed 60 second refresh made the Home app **staler**, not fresher. The plugin therefore times each re-subscription it asks for, and where one costs more than the wait it replaced it waits longer next time, up to the point where it stops asking altogether and leaves the device to report on its own. A device that answers a fresh subscription promptly keeps the interval you configured.

The default of 60 seconds suits every device tested so far; raise it if your device reports often enough on its own, or set it to `0` to switch the refresh off entirely and rely on the device alone. Values below 15 seconds are treated as 15, because a device generally needs longer than that to answer a fresh subscription.

</details>

### Log messages

#### Cannot run aioairctrl

<details>
<summary>The startup check failed. The message names one of three causes.</summary>

At startup the plugin runs `aioairctrl --help` once to check the CLI works before any device tries to use it. If that fails it reports the cause, what it ran, and how to fix it, then carries on loading, so the accessories still appear, but none of them will work until the install is fixed.

**Not installed, or not on the PATH.** The commonest case. The report includes the PATH it searched, which is usually the answer: pipx installs to `~/.local/bin`, and service accounts frequently do not search it. Install the CLI for the user that runs Homebridge, then confirm it:

```bash
pipx install aioairctrl
sudo -u homebridge aioairctrl --help
```

If the command works for you but not for that user, run `which aioairctrl` and set the `aioairctrlPath` platform option to the full path it prints.

**Found, but not executable.** The file is where the config says it is, and the Homebridge user may not run it. This is ownership or permissions, not a missing install, so reinstalling will not help:

```bash
ls -l /path/from/your/config
chmod +x /path/from/your/config
```

If `aioairctrlPath` points at a directory rather than the executable itself, the plugin says so explicitly.

**Starts, but its Python environment is broken.** The command exists and dies immediately; the plugin quotes the CLI's own output. `ModuleNotFoundError: No module named 'aioairctrl'` means the executable survived an install its libraries did not, which happens when the CLI and its dependencies went to different interpreters or users. Reinstall it:

```bash
pipx reinstall aioairctrl
```

Note that `aioairctrl` needs Python 3.12 or newer.

The shell commands above assume a Unix-like host (Linux, macOS, a Raspberry Pi). On Windows the diagnosis is the same, but run the equivalent checks under the account Homebridge runs as.

This report is always shown, even with the `error` log option switched off. Those options control per-device operational logging, not whether the plugin tells you it cannot work at all.

</details>

#### The polling process exited with code N without returning any status

<details>
<summary>aioairctrl started and died three times running. Usually a broken Python environment.</summary>

`aioairctrl` was found and started, but died three times in a row without producing anything. The plugin logs the command's own error output on the next line, minus the progress messages the CLI writes when `cliDebug` is enabled (those stay in the debug log). A Python traceback such as `ModuleNotFoundError: No module named 'aioairctrl'` means the executable exists but the Python environment behind it is incomplete, which happens when the CLI and its dependencies were installed for a different interpreter or user. Reinstall it as described under Quick start, then confirm it runs for the Homebridge user:

```bash
sudo -u homebridge aioairctrl -H <device-ip> -P 5683 status-observe -J
```

</details>

#### No status received from the device

<details>
<summary>The device took the subscription and then went quiet. Check the address, the power, and what else is talking to it.</summary>

The device accepted the subscription and then sent nothing for three restarts in a row, counted from the last reading rather than from the current subscription, so around fifteen minutes of silence. A device that has never answered at all is reported on the first of them, because that one is usually an address or a power problem rather than a device having a quiet moment.

This only appears for a purifier that is switched on, or one that has never answered at all. A purifier that has reported itself switched off is expected to go quiet, and the plugin waits for it without complaining.

Check that `host` and `port` are right, that the purifier is powered on and on the same network, and that nothing else is already talking to it. An address that used to work and stopped is usually a DHCP lease that renewed onto a different one: check the purifier's current address on your router and set a reservation for it. These purifiers serve **one connection at a time**, so a leftover process (see [Upgrading from v1.1.0 or earlier](#upgrading-from-v110-or-earlier)) or another integration polling the same device will starve the plugin. The plugin keeps retrying and logs `Device is responding again` once status resumes.

</details>

#### The device did not apply a command

<details>
<summary>The command was sent, resent, and the device still reports the old value.</summary>

The plugin sent a command, the purifier answered twice, and both answers still show the old value. Commands are sent over an unacknowledged protocol, so a command that never arrives, or that arrives while the device's radio is asleep, produces no error anywhere. The plugin resends it once before reporting this, and the Home app is corrected from the same status that showed the command had not taken effect. Commands are sent strictly one at a time, because these purifiers serve only one connection and two arriving together were measured losing one of them at a sleeping device.

These devices report on their own schedule rather than answering a command, so a status that arrives in the first few seconds after one was sent was composed before the device could act on it and still carries the old value. Such a status is not counted either way, which is why this message needs the device to keep reporting the old value rather than merely to report it once.

An occasional message is normal on a busy or distant network. If it happens every time for one control, the command is probably wrong for your model rather than lost: set `debug` to true, copy the logged `CMD: aioairctrl ...` line, run it yourself, and open an issue with what the device reports afterwards.

</details>

#### The device never answered a command sent while it was off

<details>
<summary>A wake-up command went out and nothing came back at all. Usually a packet lost in transit.</summary>

Turning a purifier on normally wakes it, and it answers within seconds even after a long silence, so a wake-up command that has produced no answer at all was most likely never received. The plugin cannot tell that apart from an ordinary quiet spell straight away, though, so it holds such a write open for as long as it already tolerates silence from an off device, rather than the few minutes it expects from one that was talking, and sends the command a second time along the way. If the device does speak at any point and is still off, the ordinary resend above takes over. This message appears only when nothing at all has been heard for the whole of that window, and the Home app is put back to the last state the device actually reported.

The usual cause is a command lost in transit, which is unremarkable once in a while on a busy or distant network. Repeatedly, and for one device only, points at signal strength or an address problem, so check where the purifier stands and what address it currently has. Turning a purifier off almost never produces this, because a running device answers quickly enough to contradict a lost command. It is the arrive-home automation that turns one **on** that this exists for.

</details>

#### aioairctrl got no answer from the device

<details>
<summary>The command timed out before the device opened a session. It is not reachable.</summary>

Sending a command is not a single packet: the CLI opens a session with the device first, and if nothing answers, that wait never ends by itself. The plugin therefore stops the attempt, reports it, and puts the Home app back to the last state the device actually reported, rather than leaving a switch showing a command that went nowhere.

The cap sits a few seconds above HomeKit's own 9 second write timeout on purpose. HomeKit gives up first, returns the switch to where it was and marks the accessory as not responding; the plugin's correction follows a few seconds later and settles the parts HomeKit does not manage itself, so the tile stops showing a change in progress. The not responding mark stays until the purifier next answers, which is the honest signal that it did not.

This means the device is not reachable, not that the install is broken: a purifier switched off at the mains or unplugged, one that has moved to another network, or one whose address has changed. An address that used to work and stopped is usually a DHCP lease that renewed onto a different one, so check the purifier's current address on your router and set a reservation for it. If the address is right and the device is powered, check that nothing else is holding its single connection, as in the section above.

</details>

#### aioairctrl rejected the command

<details>
<summary>The CLI refused to send it, so it never reached the device. Please report this one.</summary>

The `aioairctrl` CLI refused to send the command, so it never reached the device. The plugin logs the CLI's own text after this message, and `Cannot encode value 'X' as int` is the usual one: it means the value is not a number but the command asked for integer encoding. The plugin no longer builds such a command itself, so if you see this, the model mapping is sending a word where your device's register expects a number, so please open an issue with the logged `CMD:` line.

</details>

### Reporting a problem

<details>
<summary>What to include so the report can be acted on.</summary>

Open a [bug report](https://github.com/atdr/homebridge-philipsair-platform/issues/new?template=bug_report.yml). The form asks for everything below, and a report with all of it can usually be diagnosed without a round trip:

- Your device's **model ID**, as printed on the device
- The plugin, Homebridge and Node versions
- The log covering the problem, with `debug` switched on
- Your `config.json` platform block, with addresses redacted if you prefer

</details>

## Upgrading from v1.1.0 or earlier

<details>
<summary>Your accessory may be re-added once, and a leftover polling process may need killing.</summary>

Older releases registered accessories under a different internal plugin identifier, so the first restart after upgrading may remove and re-add your device in HomeKit once. The accessory keeps its name, but you may need to reassign its room and any scenes or automations that reference it.

v1.1.0 and earlier also did not stop their polling process on shutdown, so upgrading can leave one behind. Purifiers serve **one connection at a time**, so the leftover process competes with the new one and the device looks unresponsive for as long as it survives. It is reparented to `init` and will not stop on its own. After upgrading, check for one:

```bash
ps -eo pid,ppid,args | grep '[a]ioairctrl\|[p]yaircontrol'
```

Anything with a parent PID of `1` is a leftover, so `kill` it; rebooting clears it too. Later releases stop their own process on shutdown, so this is a one-time step.

</details>

## Contributing

Bug reports, device status dumps for unsupported models, and pull requests are all welcome. See [CONTRIBUTING.md](https://github.com/atdr/homebridge-philipsair-platform/blob/main/CONTRIBUTING.md) for the development setup, the quality gates, and the commit conventions.

## Credits

This plugin stands on other people's work:

- [seydx/homebridge-philipsair-platform](https://github.com/seydx/homebridge-philipsair-platform), the project this one is based on.
- [NikDevx/homebridge-philips-air](https://github.com/NikDevx/homebridge-philips-air), originally by Sunoo, which seydx's plugin drew heavily on.
- [we5/homebridge-philipsair-platform](https://github.com/we5/homebridge-philipsair-platform/tree/refactor/use-config-mappings), for the mappable config parameters.
- [`aioairctrl`](https://github.com/kongo09/aioairctrl), maintained by kongo09 and written by [betaboon](https://github.com/betaboon/aioairctrl), which does all of the talking to the device.

## License

[MIT](https://github.com/atdr/homebridge-philipsair-platform/blob/main/LICENSE). All product and company names are trademarks™ or registered® trademarks of their respective holders; use of them does not imply any affiliation with or endorsement by them.
