<p align="center">
    <img src="https://raw.githubusercontent.com/atdr/homebridge-philipsair-platform/main/images/logo.png" alt="Plugin logo" height="200">
</p>

# homebridge-philipsair-platform

[![npm](https://img.shields.io/npm/v/@atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://www.npmjs.com/package/@atdr/homebridge-philipsair-platform)
[![npm](https://img.shields.io/npm/dt/@atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://www.npmjs.com/package/@atdr/homebridge-philipsair-platform)
[![GitHub last commit](https://img.shields.io/github/last-commit/atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://github.com/atdr/homebridge-philipsair-platform)
[![CI](https://img.shields.io/github/actions/workflow/status/atdr/homebridge-philipsair-platform/ci.yml?style=flat-square&label=CI)](https://github.com/atdr/homebridge-philipsair-platform/actions/workflows/ci.yml)

## Info

This is a plugin for Philips Air Purifier/Humidifier.

This plugin supports following functions:

- Air Purifier
- Humidifier
- Device Lights
- Temperature Sensor
- Humidity Sensor

## Installation

After [Homebridge](https://github.com/homebridge/homebridge) has been installed, there are three things to install, then three to check about your device before you configure it.

### 1. Install Python 3 and pipx

Device communication is not pure JavaScript: it runs through a Python CLI, so Python and a way to install it are prerequisites. On Debian/Ubuntu:

```bash
sudo apt install python3 pipx
```

On macOS, `brew install pipx`. On Windows, install Python from [python.org](https://www.python.org/downloads/) and then `py -m pip install --user pipx`.

> The latest `aioairctrl` requires Python 3.12 or newer; on older Python versions pip/pipx will fall back to an older `aioairctrl` release.

### 2. Install the aioairctrl CLI as the user that runs Homebridge

The plugin invokes the [`aioairctrl`](https://pypi.org/project/aioairctrl/) executable, so it has to be installed for the account Homebridge runs as, not just for you:

```bash
pipx install aioairctrl
```

Then confirm that account can run it:

```bash
sudo -u homebridge aioairctrl --help
```

Any other install method works too (`pip install --user`, a virtualenv, `sudo python3 -m pip install --break-system-packages aioairctrl`, ...) as long as the `aioairctrl` command is available. If the executable is not on the PATH of the user running Homebridge, which is common with pipx because it installs to `~/.local/bin`, set the `aioairctrlPath` platform option to its full path, e.g. `/home/pi/.local/bin/aioairctrl`.

The plugin runs the same check itself at startup and says what to fix in the log if it cannot run the command. See [Cannot run aioairctrl](#cannot-run-aioairctrl) if it reports a problem.

### 3. Install this plugin

Either search for `philipsair` on the **Plugins** page of the [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x), or install it from the command line:

```bash
sudo npm install -g @atdr/homebridge-philipsair-platform@latest
```

### 4. Give the purifier a fixed address

The plugin reaches your device at the address you configure and never rediscovers it. If your router hands out addresses by DHCP, that address can change when the lease renews, and the accessory then stops responding with nothing in the log to explain why.

Set a **DHCP reservation** for the purifier on your router first, sometimes called a static lease or an address reservation, and use the reserved address in the config. A hostname such as `purifier.local` works too, on a network that resolves it reliably.

### 5. Find the model ID of your device

The plugin needs the model ID to send the right commands: fan speeds, power and the rest are encoded differently across models. It is printed on the label on the back or underside of the unit, and shown in the Philips app.

It looks like `AC0850/11`. Enter only the part before the slash, `AC0850`. The suffix is a regional variant and is not part of the ID the plugin matches.

This goes in the **Model** field, not the **Name** field:

- **Model** selects the commands the plugin sends. Get this wrong and the device appears in the Home app with controls that do nothing.
- **Name** is only your own label for the device in the Home app, such as `Bedroom Purifier`.

Putting the model ID in Name and leaving Model unset is the single most common configuration mistake with this plugin.

### 6. Check the device answers before configuring it

Confirm the purifier talks to this machine at all, using the address from step 4:

```bash
aioairctrl -H 10.0.1.16 -P 5683 status -J
```

Allow up to 90 seconds for a reply. These purifiers serve **one connection at a time**, so stop Homebridge first if it is already polling this device, and run the check with the purifier switched **on**, because one that is switched off can legitimately stay silent for half an hour.

The keys it prints are the device's own status registers, and the plugin translates them using the model mapping from step 5.

### 7. Add the device in the Homebridge UI

Open the plugin's settings and add a device, filling in **Model** (step 5), **Name** (whatever you want to see in the Home app) and **Host Address** (step 4). Everything else has a working default. The [Example Config](#example-config) section below shows the equivalent `config.json`.

## Upgrading from v1.1.0 or earlier

Older releases registered accessories under a different internal plugin identifier, so the first restart after upgrading may remove and re-add your device in HomeKit once. The accessory keeps its name, but you may need to reassign its room and any scenes/automations that reference it.

v1.1.0 and earlier also did not stop their polling process on shutdown, so upgrading can leave one behind. Purifiers serve **one connection at a time**, so the leftover process competes with the new one and the device looks unresponsive for as long as it survives. It is reparented to `init` and will not stop on its own. After upgrading, check for one:

```bash
ps -eo pid,ppid,args | grep '[a]ioairctrl\|[p]yaircontrol'
```

Anything with a parent PID of `1` is a leftover, so `kill` it; rebooting clears it too. Later releases stop their own process on shutdown, so this is a one-time step.

## Example Config

### AC3829 / AC3036

```json
{
  "platforms": [
    {
      "platform": "PhilipsAirPlatform",
      "name": "PhilipsAirPlatform",
      "aioairctrlPath": "",
      "debug": false,
      "warn": true,
      "error": true,
      "extendedError": true,
      "devices": [
        {
          "active": true,
          "name": "Livingroom Philips",
          "manufacturer": "Philips",
          "model": "AC3829",
          "serialNumber": "000000",
          "host": "192.168.178.111",
          "port": 5683,
          "refreshInterval": 60,
          "light": true,
          "temperature": true,
          "humidity": true,
          "humidifier": true,
          "allergicFunc": true,
          "sleepSpeed": true
        }
      ]
    }
  ]
}
```

### AC0850

```json
{
  "platforms": [
    {
      "platform": "PhilipsAirPlatform",
      "name": "PhilipsAirPlatform",
      "aioairctrlPath": "",
      "debug": false,
      "warn": true,
      "error": true,
      "extendedError": true,
      "devices": [
        {
          "active": true,
          "name": "Air Purifier",
          "manufacturer": "Philips",
          "model": "AC0850",
          "serialNumber": "000000",
          "host": "192.168.1.142",
          "humidifier": false,
          "light": false,
          "temperature": false,
          "humidity": false,
          "sleepSpeed": false,
          "allergicFunc": false,
          "preFilter": false,
          "carbonFilter": false,
          "hepaFilter": true
        }
      ]
    }
  ]
}
```

| Fields            | Description                                                          | Default                | Required |
| ----------------- | -------------------------------------------------------------------- | ---------------------- | -------- |
| **platform**      | Must always be `PhilipsAirPlatform`.                                 | `"PhilipsAirPlatform"` | Yes      |
| name              | For logging purposes.                                                | `"PhilipsAirPlatform"` | No       |
| aioairctrlPath    | Full path to the `aioairctrl` executable, if not on PATH.            | _(PATH lookup)_        | No       |
| debug             | Logs every device status and command. Very noisy.                    | `false`                | No       |
| warn              | Reports problems the plugin recovered from.                          | `true`                 | No       |
| error             | Reports the underlying error behind a problem. *4                    | `true`                 | No       |
| extendedError     | Enables additional output (detailed error) in the log.               | `true`                 | No       |
| **devices**       | Array of Philips air purifiers.                                      |                        | Yes      |
| - active          | Set `false` to skip this device without deleting it.                 | `true`                 | No       |
| - name            | Your own label for the device in the Home app. Not the model ID. *1  |                        | Yes      |
| - **host**        | IP address or hostname of your device. Give it a fixed address. *2   |                        | Yes      |
| - port            | Port of your device.                                                 | `5683`                 | No       |
| - refreshInterval | Seconds after a reading before asking for another one. `0` disables. | `60`                   | No       |
| - manufacturer    | Set the manufacturer name for display in the Home app.               | `"Philips"`            | No       |
| - model           | Model ID of the device; selects the speed/control mapping. *3        | `"Air Purifier"`       | Yes      |
| - serialNumber    | Set the serial number for display in the Home app.                   | `"000000"`             | No       |
| - humidifier      | Expose a separate humidifier accessory to HomeKit.                   | `false`                | No       |
| - light           | Expose device lights as lightbulbs to HomeKit.                       | `false`                | No       |
| - temperature     | Expose device temperature as temperature sensor to HomeKit.          | `false`                | No       |
| - humidity        | Expose device humidity as humidity sensor to HomeKit.                | `false`                | No       |
| - allergicFunc    | Does this device support 'allergic' function?                        | `false`                | No       |
| - sleepSpeed      | Adds a 'sleep' step below the lowest speed. *5                       | `false`                | No       |
| - preFilter       | Expose pre-filter status to HomeKit.                                 | `false`                | No       |
| - carbonFilter    | Expose active carbon filter status to HomeKit.                       | `false`                | No       |
| - hepaFilter      | Expose HEPA/NanoProtect filter status to HomeKit.                    | `false`                | No       |

For a full config.json, please look at [Example Config](https://github.com/atdr/homebridge-philipsair-platform/blob/main/example-config.json) for more details.

## Notes

1. This is your label in the Home app, nothing more. Putting the model ID here instead of in `model` is the commonest configuration mistake with this plugin, and it leaves you with a device whose controls do nothing. The plugin warns when it spots one, but it is worth getting right.
2. The plugin never rediscovers the device, so a DHCP address that changes when the lease renews breaks a working config. Set a reservation on your router, or use a hostname your network resolves reliably.
3. The ID printed on the device, without the regional suffix: `AC0850/11` means `AC0850`. This is what selects the speed and register mapping, so a wrong or missing value is what leaves a device visible in the Home app with controls that do nothing. Models outside the tested list fall back to a default mapping, which suits many purifiers but is not guaranteed to drive yours. The field is required in the config UI; a config written before it became required still loads and falls back to the default mapping.
4. Faults that stop the plugin working at all, such as an `aioairctrl` it cannot run, are always reported, whatever this is set to.
5. Ignored for models that have their own speed mapping (see the tested devices list); those use the right speeds automatically, and the plugin warns when the option cannot do anything.

Not every device supports every control. The AC0850 reports no auto/manual mode and no child lock, so neither is offered in the Home app for that model; power, fan speed, air quality and the filter status are unaffected.

## Tested devices

The following devices have been tested with this plugin and confirm that they work without problems:

- AC3036
- AC1715
- AC0850

Not yet confirmed with new configuration approach:

- AC3829

## Supported clients

This plugin has been verified to work with the following apps/systems:

- iOS > 13
- Apple Home
- All 3rd party apps like Elgato Eve etc
- Homebridge v1.8 or v2
- Node v20.18, v22.10, or v24 (matching the `engines` field in package.json)

## TODO

- [ ] FakeGato Support

## Contributing

> This project is based on <https://github.com/seydx/homebridge-philipsair-platform>, which was heavily inspired by <https://github.com/NikDevx/homebridge-philips-air>. Credit for the mappable config parameters goes to <https://github.com/we5/homebridge-philipsair-platform/tree/refactor/use-config-mappings>

You can contribute to this homebridge plugin in following ways:

- Report issues and help verify fixes as they are checked in.
- Review the source code changes.
- Contribute bug fixes.
- Contribute changes to extend the capabilities
- Pull requests are accepted.

See [CONTRIBUTING](https://github.com/atdr/homebridge-philipsair-platform/blob/main/CONTRIBUTING.md)

## Troubleshooting

If you have any issues with the plugin then you can run this plugin in debug mode, which will provide some additional information. This might be useful for debugging issues. Just open your config ui and set debug to true!

### The device appears in the Home app but none of its controls work

The accessory is there, its tiles respond to taps, and the purifier ignores every one of them. This is almost always the `model` field.

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

If the model is right and the controls still do nothing, set `debug` to true, copy a logged status line, and open an issue with it.

### Cannot run aioairctrl

At startup the plugin runs `aioairctrl --help` once to check the CLI works before any device tries to use it. If that fails it reports the cause, what it ran, and how to fix it, then carries on loading — so the accessories still appear, but none of them will work until the install is fixed. The message names one of three causes.

**Not installed, or not on the PATH.** The commonest case. The report includes the PATH it searched, which is usually the answer: pipx installs to `~/.local/bin`, and service accounts frequently do not search it. Install the CLI for the user that runs Homebridge, then confirm it:

```bash
pipx install aioairctrl
sudo -u homebridge aioairctrl --help
```

If the command works for you but not for that user, run `which aioairctrl` and set the `aioairctrlPath` platform option to the full path it prints.

**Found, but not executable.** The file is where the config says it is, and the Homebridge user may not run it. This is ownership or permissions, not a missing install — reinstalling will not help:

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

> The shell commands above assume a Unix-like host (Linux, macOS, a Raspberry Pi). On Windows the diagnosis is the same, but run the equivalent checks under the account Homebridge runs as.
>
> This report is always shown, even with the `error` log option switched off — those options control per-device operational logging, not whether the plugin tells you it cannot work at all.

### The polling process exited with code N without returning any status

`aioairctrl` was found and started, but died three times in a row without producing anything. The plugin logs the command's own error output on the next line, minus the progress messages the CLI writes when `debug` is enabled (those stay in the debug log). A Python traceback such as `ModuleNotFoundError: No module named 'aioairctrl'` means the executable exists but the Python environment behind it is incomplete, which happens when the CLI and its dependencies were installed for a different interpreter or user. Reinstall it as described under Installation, then confirm it runs for the Homebridge user:

```bash
sudo -u homebridge aioairctrl -H <device-ip> -P 5683 status-observe -J
```

### No status received from the device

The device accepted the subscription and then sent nothing for five minutes, despite the plugin asking for a fresh reading in the meantime. This only appears for a purifier that is switched on, or one that has never answered at all — a purifier that has reported itself switched off is expected to go quiet, and the plugin waits for it without complaining. Check that `host` and `port` are right, that the purifier is powered on and on the same network, and that nothing else is already talking to it. An address that used to work and stopped is usually a DHCP lease that renewed onto a different one: check the purifier's current address on your router and set a reservation for it. These purifiers serve **one connection at a time**, so a leftover process (see Upgrading above) or another integration polling the same device will starve the plugin. The plugin keeps retrying and logs `Device is responding again` once status resumes.

### The state in the Home app is out of date

These purifiers report spontaneously only while their values are changing, so a device sitting idle can stay quiet for several minutes at a time. The plugin therefore asks for a fresh reading `refreshInterval` seconds after the last one, by re-subscribing, which is what prompts the device to answer. A purifier that is switched **off** is a case of its own: some models answer only every few minutes, or not at all for half an hour, and nothing the plugin does makes them answer sooner. Its reported state stays `off` throughout, and the plugin stops asking so often rather than restarting and warning in a loop. The default of 60 seconds suits every device tested so far; raise it if your device reports often enough on its own, or set it to `0` to switch the refresh off entirely and rely on the device alone. Values below 15 seconds are treated as 15, because a device generally needs longer than that to answer a fresh subscription.

### The device did not apply a command

The plugin sent a command, the purifier answered, and its answer still shows the old value. Commands are sent over an unacknowledged protocol, so one that is lost in transit — or that arrives while the device's radio is asleep — produces no error anywhere. The plugin resends it once before reporting this, and the Home app is corrected to whatever the device actually reports, so it never keeps showing a state the device never reached.

An occasional message is normal on a busy or distant network. If it happens every time for one control, the command is probably wrong for your model rather than lost: set `debug` to true, copy the logged `CMD: aioairctrl ...` line, run it yourself, and open an issue with what the device reports afterwards.

### aioairctrl rejected the command

The `aioairctrl` CLI refused to send the command, so it never reached the device. The plugin logs the CLI's own text after this message, and `Cannot encode value 'X' as int` is the usual one: it means the value is not a number but the command asked for integer encoding. The plugin no longer builds such a command itself, so if you see this, the model mapping is sending a word where your device's register expects a number — please open an issue with the logged `CMD:` line.

## Disclaimer

All product and company names are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.
