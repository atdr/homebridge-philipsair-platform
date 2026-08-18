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

After [Homebridge](https://github.com/homebridge/homebridge) has been installed:

1. Install Python 3 and pipx (required for device communication). On Debian/Ubuntu:

```bash
sudo apt install python3 pipx
```

1. Install the [`aioairctrl`](https://pypi.org/project/aioairctrl/) CLI **as the user that runs Homebridge** (the plugin invokes the `aioairctrl` executable):

```bash
pipx install aioairctrl
```

Any other install method works too (`pip install --user`, a virtualenv, `sudo python3 -m pip install --break-system-packages aioairctrl`, ...) as long as the `aioairctrl` command is available. If the executable is not on the PATH of the user running Homebridge — common with pipx, which installs to `~/.local/bin` — set the `aioairctrlPath` platform option to its full path, e.g. `/home/pi/.local/bin/aioairctrl`.

> The latest `aioairctrl` requires Python 3.12 or newer; on older Python versions pip/pipx will fall back to an older `aioairctrl` release.

1. Install this plugin, either by searching for `philipsair` on the **Plugins** page of the [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x), or from the command line:

```bash
sudo npm install -g @atdr/homebridge-philipsair-platform@latest
```

### Upgrading from v1.1.0 or earlier

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
| aioairctrlPath    | Full path to the `aioairctrl` executable, if not on PATH.            | `"aioairctrl"`         | No       |
| debug             | Enables additional output (debug) in the log.                        | `false`                | No       |
| warn              | Enables additional output (warn) in the log.                         | `true`                 | No       |
| error             | Enables additional output (error) in the log.                        | `true`                 | No       |
| extendedError     | Enables additional output (detailed error) in the log.               | `true`                 | No       |
| **devices**       | Array of Philips air purifiers.                                      |                        | Yes      |
| - active          | Set `true` to expose the device. Inactive ones are skipped.          | `false`                | No       |
| - name            | Unique name of your device.                                          |                        | Yes      |
| - **host**        | IP address or hostname of your device.                               |                        | Yes      |
| - port            | Port of your device.                                                 | `5683`                 | No       |
| - refreshInterval | Seconds after a reading before asking for another one. `0` disables. | `60`                   | No       |
| - manufacturer    | Set the manufacturer name for display in the Home app.               | `"Philips"`            | No       |
| - model           | Set the model for display in the Home app.                           | `"Air Purifier"`       | No *1    |
| - serialNumber    | Set the serial number for display in the Home app.                   | `"000000"`             | No       |
| - humidifier      | Expose a separate humidifier accessory to HomeKit.                   | `false`                | No       |
| - light           | Expose device lights as lightbulbs to HomeKit.                       | `false`                | No       |
| - temperature     | Expose device temperature as temperature sensor to HomeKit.          | `false`                | No       |
| - humidity        | Expose device humidity as humidity sensor to HomeKit.                | `false`                | No       |
| - allergicFunc    | Does this device support 'allergic' function?                        | `false`                | No       |
| - sleepSpeed      | Does this device support 'sleep' speed?                              | `false`                | No       |
| - preFilter       | Expose pre-filter status to HomeKit.                                 | `false`                | No       |
| - carbonFilter    | Expose active carbon filter status to HomeKit.                       | `false`                | No       |
| - hepaFilter      | Expose HEPA/NanoProtect filter status to HomeKit.                    | `false`                | No       |

For a full config.json, please look at [Example Config](https://github.com/atdr/homebridge-philipsair-platform/blob/main/example-config.json) for more details.

## Notes

1. Use model IDs from the tested devices list below for full compatibility. For AC0850 this field is required for correct speed/key mapping.

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

### aioairctrl not found

The plugin could not run the `aioairctrl` executable. Check that it is installed for the user that runs Homebridge (`sudo -u homebridge aioairctrl --help`, adjusting the username to your setup). If the command only works for another user or lives outside the PATH — pipx installs to `~/.local/bin` — set the `aioairctrlPath` platform option to the full path reported by `which aioairctrl`.

### The polling process exited with code N without returning any status

`aioairctrl` was found and started, but died three times in a row without producing anything. The plugin logs the command's own error output on the next line. A Python traceback such as `ModuleNotFoundError: No module named 'aioairctrl'` means the executable exists but the Python environment behind it is incomplete, which happens when the CLI and its dependencies were installed for a different interpreter or user. Reinstall it as described under Installation, then confirm it runs for the Homebridge user:

```bash
sudo -u homebridge aioairctrl -H <device-ip> -P 5683 status-observe -J
```

### No status received from the device

The device accepted the subscription and then sent nothing for five minutes, despite the plugin asking for a fresh reading in the meantime. This only appears for a purifier that is switched on, or one that has never answered at all — a purifier that has reported itself switched off is expected to go quiet, and the plugin waits for it without complaining. Check that `host` and `port` are right, that the purifier is powered on and on the same network, and that nothing else is already talking to it. These purifiers serve **one connection at a time**, so a leftover process (see Upgrading above) or another integration polling the same device will starve the plugin. The plugin keeps retrying and logs `Device is responding again` once status resumes.

### The state in the Home app is out of date

These purifiers report spontaneously only while their values are changing, so a device sitting idle can stay quiet for several minutes at a time. The plugin therefore asks for a fresh reading `refreshInterval` seconds after the last one, by re-subscribing, which is what prompts the device to answer. A purifier that is switched **off** is a case of its own: some models answer only every few minutes, or not at all for half an hour, and nothing the plugin does makes them answer sooner. Its reported state stays `off` throughout, and the plugin stops asking so often rather than restarting and warning in a loop. The default of 60 seconds suits every device tested so far; raise it if your device reports often enough on its own, or set it to `0` to switch the refresh off entirely and rely on the device alone. Values below 15 seconds are treated as 15, because a device generally needs longer than that to answer a fresh subscription.

### The device did not apply a command

The plugin sent a command, the purifier answered, and its answer still shows the old value. Commands are sent over an unacknowledged protocol, so one that is lost in transit — or that arrives while the device's radio is asleep — produces no error anywhere. The plugin resends it once before reporting this, and the Home app is corrected to whatever the device actually reports, so it never keeps showing a state the device never reached.

An occasional message is normal on a busy or distant network. If it happens every time for one control, the command is probably wrong for your model rather than lost: set `debug` to true, copy the logged `CMD: aioairctrl ...` line, run it yourself, and open an issue with what the device reports afterwards.

### aioairctrl rejected the command

The `aioairctrl` CLI refused to send the command, so it never reached the device. The plugin logs the CLI's own text after this message, and `Cannot encode value 'X' as int` is the usual one: it means the value is not a number but the command asked for integer encoding. The plugin no longer builds such a command itself, so if you see this, the model mapping is sending a word where your device's register expects a number — please open an issue with the logged `CMD:` line.

## Disclaimer

All product and company names are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.
