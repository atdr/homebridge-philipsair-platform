<p align="center">
    <img src="https://raw.githubusercontent.com/atdr/homebridge-philipsair-platform/main/images/logo.png" alt="Plugin logo" height="200">
</p>

# homebridge-philipsair-platform

[![npm](https://img.shields.io/npm/v/@atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://www.npmjs.com/package/@atdr/homebridge-philipsair-platform)
[![npm](https://img.shields.io/npm/dt/@atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://www.npmjs.com/package/@atdr/homebridge-philipsair-platform)
[![GitHub last commit](https://img.shields.io/github/last-commit/atdr/homebridge-philipsair-platform.svg?style=flat-square)](https://github.com/atdr/homebridge-philipsair-platform)

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

1. Install Python 3 and pip (required for device communication). On Debian/Ubuntu:

```bash
sudo apt install python3 python3-pip
```

1. Install the [`aioairctrl`](https://pypi.org/project/aioairctrl/) Python module into the system Python. On Debian 12+, Ubuntu 23.04+, and Raspberry Pi OS Bookworm or later:

```bash
sudo python3 -m pip install --break-system-packages aioairctrl
```

On older systems, where pip does not enforce PEP 668 yet, a plain `sudo pip3 install aioairctrl` works too.

> **Warning:** installing `aioairctrl` with **pipx or inside a virtual environment will not work**. The plugin runs the system `python3` and imports the `aioairctrl` module directly, so isolated installs are invisible to it, even though the `aioairctrl` command works in your shell. See [#1](https://github.com/atdr/homebridge-philipsair-platform/issues/1) for the planned fix.
>
> The latest `aioairctrl` requires Python 3.12 or newer; on older Python versions pip will fall back to an older `aioairctrl` release.

1. Install this plugin:

```bash
sudo npm install -g --unsafe-perm @atdr/homebridge-philipsair-platform@latest
```

## Example Config

### AC3829 / AC3036

```json
{
    "platforms": [
        {
            "platform": "PhilipsAirPlatform",
            "name": "PhilipsAirPlatform",
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
                    "port": 3333,
                    "light": true,
                    "temperature": true,
                    "humidity": true,
                    "humidifier": true,
                    "allergicFunc": true,
                    "sleepSpeed": false
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

| Fields           | Description                                                  | Default                | Required |
|------------------|--------------------------------------------------------------|------------------------|----------|
| **platform**     | Must always be `PhilipsAirPlatform`.                         | `"PhilipsAirPlatform"` | Yes      |
| name             | For logging purposes.                                        | `"PhilipsAirPlatform"` | No       |
| debug            | Enables additional output (debug) in the log.                | `false`                | No       |
| warn             | Enables additional output (warn) in the log.                 | `true`                 | No       |
| error            | Enables additional output (error) in the log.                | `true`                 | No       |
| extendedError    | Enables additional output (detailed error) in the log.       | `true`                 | No       |
| **devices**      | Array of Philips air purifiers.                              |                        | Yes      |
|- active          | Set `true` to expose the device. Inactive ones are skipped.  | `false`                | No       |
|- name            | Unique name of your device.                                  |                        | Yes      |
|- **host**        | Host/IP address of your device.                              |                        | Yes      |
|- port            | Port of your device.                                         | `5683`                 | No       |
|- manufacturer    | Set the manufacturer name for display in the Home app.       | `"Philips"`            | No       |
|- model           | Set the model for display in the Home app.                   | `"Air Purifier"`       | No *1    |
|- serialNumber    | Set the serial number for display in the Home app.           | `"000000"`             | No       |
|- humidifier      | Expose a separate humidifier accessory to HomeKit.           | `false`                | No       |
|- light           | Expose device lights as lightbulbs to HomeKit.               | `false`                | No       |
|- temperature     | Expose device temperature as temperature sensor to HomeKit.  | `false`                | No       |
|- humidity        | Expose device humidity as humidity sensor to HomeKit.        | `false`                | No       |
|- allergicFunc    | Does this device support 'allergic' function?                | `false`                | No       |
|- sleepSpeed      | Does this device support 'sleep' speed?                      | `false`                | No       |
|- preFilter       | Expose pre-filter status to HomeKit.                         | `false`                | No       |
|- carbonFilter    | Expose active carbon filter status to HomeKit.               | `false`                | No       |
|- hepaFilter      | Expose HEPA/NanoProtect filter status to HomeKit.            | `false`                | No       |

For a full config.json, please look at [Example Config](https://github.com/atdr/homebridge-philipsair-platform/blob/main/example-config.json) for more details.

## Notes

1. Use model IDs from the tested devices list below for full compatibility. For AC0850 this field is required for correct speed/key mapping.

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
- Homebridge v1.8 or later (including the v2.0 beta)
- Node v20.18, v22.10, or v24 (matching the `engines` field in package.json)

## TODO

- [ ] Invoke the `aioairctrl` CLI directly instead of importing the module via `python3`, so pipx/venv installs work ([#1](https://github.com/atdr/homebridge-philipsair-platform/issues/1))
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

### ModuleNotFoundError: No module named 'aioairctrl'

The `aioairctrl` module is not importable by the system `python3`. This typically happens when it was installed with pipx or inside a virtual environment, which the plugin cannot see ([#1](https://github.com/atdr/homebridge-philipsair-platform/issues/1)). Reinstall it into the system interpreter:

```bash
sudo python3 -m pip install --break-system-packages aioairctrl
```

## Disclaimer

All product and company names are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.
