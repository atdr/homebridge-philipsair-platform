'use strict';

//Drift guards that keep README.md in step with the source of truth
//(config.schema.json, example-config.json and accessories.models.js). They cover
//the three parts of the README that go stale silently: the config option tables,
//the full config example, and the list of models with a dedicated mapping.
//
//Same shape as config.schema.test.js: read the files, assert the invariant. If a
//check here fails, the fix is almost always to update the doc, not to weaken the
//test. Each check names the README section it reads, so a restructure that moves
//or renames a heading has to update the slice here too.

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

//The body of a '## Heading' section, up to the next top-level heading. Anchored
//to the start of a line so a '### ' subheading inside the section does not end
//the slice, which a plain indexOf('## ') would do.
const section = (heading) => {
  const start = readme.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `README has no '## ${heading}' section`);
  const rest = readme.slice(start + heading.length + 4);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
};

//Field tables live under '## Configuration' only. Scoping the parse there keeps
//an unrelated table elsewhere in the README from being read as a config option.
const configSection = section('Configuration');
const deviceSupportSection = section('Device support');

//First column of every Markdown table row in the configuration section, stripped
//of the formatting the README uses for field names: '| `host` |' -> 'host'.
const readmeFieldCells = new Set(
  configSection
    .split('\n')
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|')[1] ?? '')
    .map((cell) => cell.replace(/[`*-]/g, '').trim())
);

//Fenced ```json blocks in the README. There should be exactly one, the full
//config example, and it has to stay in step with example-config.json.
const jsonBlocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);

describe('docs', () => {
  it('documents every config.schema.json property in the README field tables', () => {
    for (const prop of platformProps) {
      assert.ok(
        readmeFieldCells.has(prop),
        `platform option '${prop}' is in config.schema.json but missing from the README field tables`
      );
    }

    for (const prop of deviceProps) {
      assert.ok(
        readmeFieldCells.has(prop),
        `device option '${prop}' is in config.schema.json but missing from the README field tables`
      );
    }
  });

  it('has no README field-table row for an option that is not in config.schema.json', () => {
    const knownOptions = new Set([...platformProps, ...deviceProps, ...structuralKeys]);

    for (const cell of readmeFieldCells) {
      //skip the header cells and the empty cell from each separator row
      if (!cell || cell === 'Option') {
        continue;
      }
      assert.ok(
        knownOptions.has(cell),
        `README field table documents '${cell}', which is not defined in config.schema.json`
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

  it('keeps the README config example identical to example-config.json', () => {
    assert.equal(jsonBlocks.length, 1, 'README should contain exactly one ```json block, the full config example');
    assert.deepEqual(
      JSON.parse(jsonBlocks[0]),
      exampleConfig,
      'the README config example has drifted from example-config.json'
    );
  });

  it('lists every model with a dedicated mapping in the README device-support section', () => {
    for (const model of mappedModels) {
      assert.ok(
        deviceSupportSection.includes(model),
        `model ${model} from accessories.models.js is missing from the README 'Device support' section`
      );
    }
  });
});
