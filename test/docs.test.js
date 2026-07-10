'use strict';

//Drift guards that keep the human-facing docs in step with the source of truth
//(config.schema.json and accessories.models.js). Same shape as
//config.schema.test.js: read the files, assert the invariant. If a check here
//fails, the fix is almost always to update the doc, not to weaken the test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { mappedModels } = require('../src/accessories/accessories.models');

const root = path.join(__dirname, '..');
const readFile = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const schema = JSON.parse(readFile('config.schema.json')).schema;
const exampleConfig = JSON.parse(readFile('example-config.json'));
const readme = readFile('README.md');

const platformProps = Object.keys(schema.properties);
//'platform' is the Homebridge plugin alias, always present in a config block but
//not a user-tunable schema property, so it is exempt from the schema checks.
const structuralKeys = new Set(['platform']);
const deviceProps = Object.keys(schema.properties.devices.items.properties);

//First column of every Markdown table row, stripped of the formatting the
//README uses for field names: `| - **host** |` -> `host`.
const readmeFieldCells = new Set(
  readme
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|')[1] ?? '')
    .map((cell) => cell.replace(/[`*-]/g, '').trim())
);

//Body of the '## Tested devices' section, up to the next heading.
const testedDevicesSection = readme.slice(
  readme.indexOf('## Tested devices'),
  readme.indexOf('## ', readme.indexOf('## Tested devices') + 1)
);

describe('docs', () => {
  it('documents every config.schema.json property in the README field table', () => {
    for (const prop of platformProps) {
      assert.ok(
        readmeFieldCells.has(prop),
        `platform option '${prop}' is in config.schema.json but missing from the README field table`
      );
    }

    for (const prop of deviceProps) {
      assert.ok(
        readmeFieldCells.has(prop),
        `device option '${prop}' is in config.schema.json but missing from the README field table`
      );
    }
  });

  it('uses only config.schema.json properties in example-config.json', () => {
    const platform = exampleConfig.platforms[0];

    for (const key of Object.keys(platform)) {
      if (structuralKeys.has(key)) {
        continue;
      }
      assert.ok(
        schema.properties[key],
        `example-config.json sets platform option '${key}', which is not defined in config.schema.json`
      );
    }

    for (const device of platform.devices) {
      for (const key of Object.keys(device)) {
        assert.ok(
          schema.properties.devices.items.properties[key],
          `example-config.json sets device option '${key}', which is not defined in config.schema.json`
        );
      }
    }
  });

  it('lists every model with a dedicated mapping in the README tested-devices section', () => {
    for (const model of mappedModels) {
      assert.ok(
        testedDevicesSection.includes(model),
        `model ${model} from accessories.models.js is missing from the README 'Tested devices' section`
      );
    }
  });
});
