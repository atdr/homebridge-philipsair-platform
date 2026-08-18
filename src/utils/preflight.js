'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');

//long enough for a cold Python interpreter to start on a Raspberry Pi, short
//enough that a wedged binary cannot hold up accessory setup
const PROBE_TIMEOUT = 5 * 1000;

//how much of the CLI's own output is kept for the report. a broken Python
//environment says why in its traceback, and that is the whole diagnosis
const MAX_DETAIL = 2 * 1024;

/**
 * @typedef {'ok' | 'not-found' | 'not-executable' | 'failed'} PreflightKind
 * @typedef {object} PreflightResult
 * @property {boolean} ok
 * @property {PreflightKind} kind
 * @property {string} binary what the plugin will actually execute
 * @property {boolean} fromPath true when `binary` is resolved via PATH
 * @property {string} detail the CLI's own words, when it had any
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
const tail = (value) =>
  String(value ?? '')
    .trim()
    .slice(-MAX_DETAIL);

/**
 * Checks that the configured `aioairctrl` can actually be run, before any
 * device tries to use it.
 *
 * The probe is `aioairctrl --help`: it needs no device, no network and no
 * `-H`, exits 0 on a healthy install, and is the exact command the README
 * already tells users to run by hand — so the plugin's verdict and the user's
 * own check can never disagree.
 *
 * An explicit path is checked with stat/access first, so "you typed the wrong
 * path" and "it is there but not executable" are told apart before spawning;
 * those two have completely different remedies and `execFile` alone reports
 * both as an errno.
 *
 * Never throws and never rejects: a preflight that blew up would be worse than
 * the missing check it replaces.
 *
 * @param {string} binary
 * @returns {Promise<PreflightResult>}
 */
async function checkAioairctrl(binary) {
  const command = binary || 'aioairctrl';
  const fromPath = !command.includes('/');

  /**
   * @param {PreflightKind} kind
   * @param {string} [detail]
   * @returns {PreflightResult}
   */
  const result = (kind, detail = '') => ({ ok: kind === 'ok', kind, binary: command, fromPath, detail });

  if (!fromPath) {
    try {
      const stats = await fsp.stat(command);

      //a directory carries the execute bit as 'searchable', so access(X_OK)
      //happily passes one. pointing aioairctrlPath at a folder is a common
      //slip and deserves its own answer rather than a confusing EACCES later
      if (!stats.isFile()) {
        return result('not-executable', 'The path exists but is a directory, not a file.');
      }

      await fsp.access(command, fs.constants.X_OK);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;

      if (code === 'ENOENT') {
        return result('not-found', 'No such file or directory.');
      }

      return result('not-executable', code === 'EACCES' ? 'The file exists but is not executable.' : tail(err));
    }
  }

  return new Promise((resolve) => {
    //execFile validates argv[0] before it ever spawns and throws synchronously
    //on a value it will not accept. letting that escape would turn a bad config
    //value into an unhandled rejection inside didFinishLaunching
    try {
      execFile(command, ['--help'], { timeout: PROBE_TIMEOUT }, (err, stdout, stderr) => {
        if (!err) {
          return resolve(result('ok'));
        }

        const code = /** @type {NodeJS.ErrnoException} */ (err).code;

        if (code === 'ENOENT') {
          return resolve(result('not-found', 'Command not found.'));
        }

        if (code === 'EACCES' || code === 'EPERM') {
          return resolve(result('not-executable', 'The file exists but is not executable.'));
        }

        //execFile reports a timeout as a kill, not an errno
        if (/** @type {{ killed?: boolean }} */ (err).killed) {
          return resolve(result('failed', `It did not respond within ${PROBE_TIMEOUT / 1000}s and was stopped.`));
        }

        //a non-zero exit means the command exists and its own runtime is
        //broken. the traceback is the diagnosis, so prefer it over node's
        //wrapper message
        return resolve(result('failed', tail(stderr) || tail(stdout) || tail(err)));
      });
    } catch (err) {
      resolve(result('not-found', tail(err)));
    }
  });
}

/**
 * The report a user sees when the preflight fails. Written to be read once, in
 * a log, by someone who has not read the source: it names the exact command
 * that failed, what went wrong in plain words, the CLI's own output, and the
 * shell commands that fix that specific cause. `<homebridge-user>` is left as a
 * placeholder because the plugin cannot know the account Homebridge runs as.
 *
 * @param {PreflightResult} check
 * @returns {string}
 */
function describeFailure(check) {
  const lines = [
    `Cannot run '${check.binary}', which this plugin needs to talk to your devices. No device will work until this is fixed.`,
    `  Tried: ${check.binary} --help`,
  ];

  if (check.fromPath) {
    //the single most useful line for the commonest failure: pipx installs to
    //~/.local/bin, which is routinely absent from a service account's PATH
    lines.push(`  Searched PATH: ${process.env.PATH || '(empty)'}`);
  }

  if (check.detail) {
    lines.push(`  ${check.binary} said: ${check.detail.split('\n').join('\n    ')}`);
  }

  if (check.kind === 'not-found') {
    lines.push(
      check.fromPath
        ? '  Cause: aioairctrl is not installed, or not on the PATH of the user running Homebridge (pipx installs it to ~/.local/bin, which services often do not search).'
        : "  Cause: the 'aioairctrlPath' in your config does not point at an existing file."
    );
    lines.push('  Fix: install it as the user that runs Homebridge:  pipx install aioairctrl');
    lines.push("  Then, if the command still is not found, run 'which aioairctrl' as that user");
    lines.push("  and put the full path it prints into the 'aioairctrlPath' platform setting.");
  } else if (check.kind === 'not-executable') {
    lines.push('  Cause: the file is there, but the Homebridge user may not execute it.');
    lines.push(`  Fix: check ownership and permissions:  ls -l ${check.binary}`);
    lines.push(`  and make it executable if it is not:  chmod +x ${check.binary}`);
  } else {
    lines.push('  Cause: aioairctrl starts but its Python environment is broken.');
    lines.push('  A "ModuleNotFoundError" above means the command survived an install its libraries did not.');
    lines.push('  Fix: reinstall it for the right interpreter:  pipx reinstall aioairctrl');
    lines.push('  (aioairctrl needs Python 3.12 or newer.)');
  }

  lines.push(`  Reproduce it yourself:  sudo -u <homebridge-user> ${check.binary} --help`);
  lines.push(
    '  Full instructions: README "Cannot run aioairctrl" — https://github.com/atdr/homebridge-philipsair-platform#troubleshooting'
  );

  return lines.join('\n');
}

module.exports = { checkAioairctrl, describeFailure, PROBE_TIMEOUT };
