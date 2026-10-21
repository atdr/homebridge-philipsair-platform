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

//The device tier table: a header row naming each tier, then a 'Models' row
//whose cells are '<ul><li>AC0850 ★</li>...</ul>'. A column whose header starts
//with 'Supported' promises a dedicated mapping; the last one is the default.
const tierRow = (label) =>
  deviceSupportSection
    .split('\n')
    .find((line) => line.startsWith('|') && line.split('|')[1].trim() === label)
    ?.split('|')
    .slice(2, -1)
    .map((cell) => cell.trim());

const tierNames = tierRow('Tier') || [];
const tierModels = tierRow('**Models**') || [];

const listed = tierModels.map((cell) => [...cell.matchAll(/<li>([^<]+)<\/li>/g)].map((match) => match[1].trim()));
const supportedModels = listed
  .filter((_, index) => (tierNames[index] || '').startsWith('Supported'))
  .flat()
  .map((item) => item.replace('★', '').trim());
const validatedModels = listed
  .flat()
  .filter((item) => item.includes('★'))
  .map((item) => item.replace('★', '').trim());

//The body of a '### Heading' subsection within an already sliced section.
const subsection = (text, heading) => {
  const start = text.indexOf(`### ${heading}\n`);
  assert.notEqual(start, -1, `README has no '### ${heading}' subsection`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/^#{2,3} /m);
  return end === -1 ? rest : rest.slice(0, end);
};

//Each Markdown table in a slice, as an ordered list of the option names in its
//first column, stripped of the formatting the README uses: '| `host` |' -> 'host'.
//A run of table rows ends at the first line that is not one, so the required and
//optional device tables stay separate.
const tables = (text) => {
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      found.push(current);
    }
    //the separator row reduces to '' once the dashes are stripped
    const cell = (line.split('|')[1] ?? '').replace(/[`*-]/g, '').trim();
    if (cell && cell !== 'Option') {
      current.push(cell);
    }
  }
  return found;
};

const platformTables = tables(subsection(configSection, 'Platform options'));
const deviceTables = tables(subsection(configSection, 'Device options'));
const readmeFieldCells = new Set([...platformTables, ...deviceTables].flat());

//Every option key named in config.schema.json's 'layout', in the order the
//Homebridge UI renders it. Sections are flattened: the README does not reproduce
//the UI's grouping, only its ordering, which is what this collects.
const layoutKeys = (node, out = []) => {
  if (Array.isArray(node)) {
    node.forEach((child) => layoutKeys(child, out));
  } else if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object') {
    if (typeof node.key === 'string') {
      out.push(node.key);
    }
    if (node.items) {
      layoutKeys(node.items, out);
    }
  }
  return out;
};

const allLayoutKeys = layoutKeys(JSON.parse(readFile('config.schema.json')).layout);
const positions = (keys) => new Map(keys.map((key, index) => [key, index]));
const platformOrder = positions(allLayoutKeys.filter((key) => !key.includes('[')));
const deviceOrder = positions(
  allLayoutKeys.map((key) => /^devices\[\]\.(\w+)$/.exec(key)?.[1]).filter((key) => key !== undefined)
);

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

  it('orders each README option table the way the Homebridge UI does', () => {
    const check = (table, order, label) => {
      const indices = table.map((option) => order.get(option)).filter((index) => index !== undefined);
      for (let i = 1; i < indices.length; i += 1) {
        assert.ok(
          indices[i] > indices[i - 1],
          `${label} lists '${table[i]}' out of the order config.schema.json's layout puts it in`
        );
      }
    };

    platformTables.forEach((table) => check(table, platformOrder, 'README platform options table'));
    deviceTables.forEach((table) => check(table, deviceOrder, 'README device options table'));
  });

  //markdownlint's MD053 already reports a footnote definition nothing references,
  //because it parses one as a link reference definition. It does not report the
  //other direction: MD052 does not treat '[^name]' as a reference it can resolve,
  //so an undefined footnote reference lints clean and renders as literal text.
  it('defines every footnote the README references', () => {
    const defined = new Set([...readme.matchAll(/^\[\^([^\]]+)\]:/gm)].map((match) => match[1]));

    for (const [, name] of readme.matchAll(/\[\^([^\]]+)\](?!:)/g)) {
      assert.ok(defined.has(name), `README references footnote [^${name}] but never defines it`);
    }
  });

  it('has a device tier table with Supported tiers and a Models row', () => {
    assert.ok(tierModels.length > 0, "README 'Device support' has no tier table with a '**Models**' row");
    assert.ok(supportedModels.length > 0, "README 'Device support' lists no model in a 'Supported' tier");
  });

  //the Supported tiers promise a dedicated mapping, so a model listed there
  //without an entry in accessories.models.js silently runs the default one
  it('lists exactly the models with a dedicated mapping in the Supported tiers', () => {
    for (const model of supportedModels) {
      assert.ok(
        mappedModels.includes(model),
        `README lists ${model} as Supported, but accessories.models.js has no entry for it`
      );
    }

    for (const model of mappedModels) {
      assert.ok(
        supportedModels.includes(model),
        `model ${model} from accessories.models.js is missing from the README Supported tiers`
      );
    }
  });

  it('marks a model validated (★) only within the Supported tiers', () => {
    assert.ok(validatedModels.length > 0, 'README marks no model as validated (★)');

    for (const model of validatedModels) {
      assert.ok(supportedModels.includes(model), `README marks ${model} validated (★) outside the Supported tiers`);
    }
  });

  //the slider layout is what a user sees of the speed table, and it changes
  //whenever a step is added or Auto moves off the slider
  it('gives every mapped model a README slider row with one step per speed', () => {
    const rows = subsection(deviceSupportSection, 'Fan speed and Auto')
      .split('\n')
      .filter((line) => line.trimStart().startsWith('|'))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const modelConfig = require('../src/accessories/accessories.models');

    for (const model of mappedModels) {
      const row = rows.find((cells) => cells[1] === model);
      assert.ok(row, `the README 'Fan speed and Auto' table has no row for ${model}`);

      const steps = (row[2].match(/\d+%/g) || []).length;
      assert.equal(steps, modelConfig({ model }).speeds.length, `the README slider row for ${model} is out of date`);
    }
  });
});

//The model format is documented in two places: the header comment of
//accessories.models.js and the dialect section of the protocol skill. A field
//added to a model entry without either goes unexplained, and one modelConfig
//does not pass through is silently ignored.
describe('model format', () => {
  const modelsSource = readFile('src/accessories/accessories.models.js');
  const header = modelsSource.slice(modelsSource.indexOf('\n'), modelsSource.indexOf('\nconst '));
  const skill = readFile('.claude/skills/aioairctrl-and-device-protocol/SKILL.md');
  const dialects = skill.slice(skill.indexOf('## The three model dialects'), skill.indexOf('## Speed model'));
  const { modelFields } = require('../src/accessories/accessories.models');

  it('finds the fields the models use', () => {
    assert.ok(modelFields.includes('speeds'), 'modelFields does not list speeds');
  });

  it('documents every field in the accessories.models.js header comment', () => {
    for (const field of modelFields) {
      assert.ok(header.includes(`'${field}'`), `accessories.models.js header does not document '${field}'`);
    }
  });

  it('documents every field in the protocol skill dialect section', () => {
    for (const field of modelFields) {
      assert.ok(dialects.includes(`\`${field}`), `the protocol skill dialect section does not name \`${field}\``);
    }
  });

  //modeMaps entries are a vocabulary of their own, including the default map's
  it('documents every modeMaps entry in the header comment and the protocol skill', () => {
    const modelConfig = require('../src/accessories/accessories.models');
    const entries = new Set(
      [undefined, ...modelConfig.mappedModels].flatMap((model) => Object.keys(modelConfig({ model }).modeMaps || {}))
    );

    assert.ok(entries.has('auto'), 'no model declares a modeMaps auto entry');
    for (const entry of entries) {
      assert.ok(header.includes(`'${entry}'`), `accessories.models.js header does not document modeMaps '${entry}'`);
      assert.ok(dialects.includes(`\`${entry}\``), `the protocol skill dialect section does not name \`${entry}\``);
    }
  });

  it('passes every field through modelConfig', () => {
    const passed = Object.keys(require('../src/accessories/accessories.models')({}));

    for (const field of modelFields) {
      assert.ok(passed.includes(field), `modelConfig drops the '${field}' field`);
    }
  });
});
