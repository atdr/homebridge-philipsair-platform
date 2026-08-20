'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { DEFAULT_BINARY, PROBE_ARGS } = require('../src/utils/preflight');

const { mappedModels } = require('../src/accessories/accessories.models');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));

const findLayoutItem = (node, key) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findLayoutItem(child, key);
      if (found) {
        return found;
      }
    }
  } else if (node && typeof node === 'object') {
    if (node.key === key) {
      return node;
    }
    return findLayoutItem(node.items, key);
  }
  return undefined;
};

//the ancestor chain down to a layout item, so a test can assert not just that
//an item exists but where it sits in the rendered form
const findLayoutPath = (node, key, trail = []) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findLayoutPath(child, key, trail);
      if (found) {
        return found;
      }
    }
  } else if (node && typeof node === 'object') {
    if (node.key === key) {
      return [...trail, node];
    }
    return findLayoutPath(node.items, key, [...trail, node]);
  }
  return undefined;
};

describe('config.schema', () => {
  it('suggests every model with a dedicated mapping in the model typeahead', () => {
    const modelItem = findLayoutItem(schema.layout, 'devices[].model');

    assert.ok(modelItem, 'devices[].model layout item not found');
    assert.ok(Array.isArray(modelItem.typeahead?.source), 'devices[].model has no typeahead source');

    for (const model of mappedModels) {
      assert.ok(
        modelItem.typeahead.source.includes(model),
        `model ${model} from accessories.models.js is missing from the typeahead suggestions`
      );
    }
  });

  //both carry a minimum AND a maximum, which makes the schema form render a
  //slider with no readout — you cannot see or type a port. Naming the widget
  //explicitly is what keeps them as number inputs.
  for (const key of ['devices[].port', 'devices[].refreshInterval']) {
    it(`renders ${key} as a number input rather than a slider`, () => {
      const item = findLayoutItem(schema.layout, key);

      assert.ok(item, `${key} layout item not found`);
      assert.equal(item.type, 'number', `${key} must name its widget or it renders as a range slider`);
    });
  }

  //model is not cosmetic: accessories.models.js keys the speed, register and
  //value maps off it, so a wrong value silently degrades the device to default
  //mappings. It must not drift back behind a collapsed sub-section.
  it('keeps the model field visible without expanding anything', () => {
    const trail = findLayoutPath(schema.layout, 'devices[].model');

    assert.ok(trail, 'devices[].model layout item not found');

    const collapsed = trail.slice(0, -1).filter((node) => node.expandable && node.expanded === false);

    assert.deepEqual(
      collapsed.map((node) => node.title),
      [],
      'devices[].model is nested inside a collapsed section; it selects the device speed/register maps'
    );
  });

  //A default of 'Air Purifier' is what taught users the field was a display
  //label: the box arrived pre-filled with a generic name, so someone who had
  //already typed 'AC0850' into Name had no reason to touch it. There must be
  //nothing to pre-fill, and the hint must be a model the plugin actually maps.
  it('offers no default model and hints with a real model ID', () => {
    const model = schema.schema.properties.devices.items.properties.model;

    assert.equal(model.default, undefined, 'devices[].model must not pre-fill a value; it is not a display label');
    assert.ok(
      mappedModels.includes(model.placeholder),
      `devices[].model placeholder '${model.placeholder}' is not a model mapped in accessories.models.js`
    );
  });

  //Asserting the header contains the words it was written with would only
  //restate the schema. What is worth guarding is that the instructions stay
  //true of how the plugin actually behaves, and stay in step with the README:
  //copy in two places, describing code in a third, is what drifts.
  describe('config UI header instructions', () => {
    const header = schema.headerDisplay;

    it('names the executable the plugin actually runs by default', () => {
      assert.match(
        header,
        new RegExp(`\\b${DEFAULT_BINARY}\\b`),
        `the header must name '${DEFAULT_BINARY}', the command the plugin runs when aioairctrlPath is unset`
      );
    });

    //the header tells users to verify their install by hand; if that command
    //is not the one the preflight runs, the plugin and the user can disagree
    //about whether the install works
    it('tells users to verify with the command the preflight actually probes with', () => {
      const probe = `${DEFAULT_BINARY} ${PROBE_ARGS.join(' ')}`;

      assert.ok(
        header.includes(probe),
        `the header must tell users to run '${probe}', which is what src/utils/preflight.js runs`
      );
    });

    //the header ends by telling users to fill in a named field; if that title
    //is renamed the instruction points at a field that no longer exists
    it('refers to the aioairctrlPath field by its real title', () => {
      const title = schema.schema.properties.aioairctrlPath.title;

      assert.ok(header.includes(title), `the header must name the '${title}' field by its actual title`);
    });

    //two places tell users how to install the CLI. The README is the doc of
    //record, so the UI must not recommend something different
    it('recommends the same install command as the README', () => {
      const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
      const install = readme.match(/^pipx install \S+$/m);

      assert.ok(install, 'no pipx install command found in the README');
      assert.ok(
        header.includes(install[0]),
        `the README installs with '${install[0]}' but the config UI header recommends something else`
      );
    });
  });

  //An array layout's items are its element templates: @ng-formworks/core
  //treats every entry that does not resolve to a dataPointer under
  //<array>/- as another element of the array. A keyless node -- a help or
  //message block, say -- therefore renders as an extra device tab, shifts
  //every real device onto the wrong data index, and inflates listItems, so
  //buildFormGroupTemplate materialises a phantom device that saving writes
  //back to config.json. Keyless decoration has to be nested inside a keyed
  //child, or hung outside the array entirely.
  it('puts nothing keyless directly inside an array layout, which would count as a device', () => {
    const offenders = [];

    const walk = (node, insideArray) => {
      if (Array.isArray(node)) {
        for (const child of node) {
          walk(child, insideArray);
        }
        return;
      }
      if (!node || typeof node !== 'object') {
        return;
      }
      if (insideArray && node.key === undefined) {
        offenders.push(node.type ?? JSON.stringify(node));
      }
      walk(node.items, typeof node.type === 'string' && node.type.endsWith('array'));
    };

    walk(schema.layout, false);

    assert.deepEqual(
      offenders,
      [],
      `these layout nodes sit straight inside an array and have no key, so each renders as an array element: ${offenders.join(', ')}`
    );
  });

  //Observed in a live Homebridge UI on 1.2.0-beta.6: headerDisplay renders
  //markdown, but a property's description does not -- backticks in one showed
  //up verbatim as `aioairctrl`. The two fields look interchangeable in the
  //JSON, so nothing but this stops the mistake being made again.
  it('does not put markdown in property descriptions, which render verbatim', () => {
    const offenders = [];

    const walk = (properties, where) => {
      for (const [key, value] of Object.entries(properties)) {
        if (/[`*]|\]\(/.test(value.description ?? '')) {
          offenders.push(`${where}.${key}`);
        }
        if (value.type === 'array') {
          walk(value.items.properties, `${where}.${key}[]`);
        }
      }
    };

    walk(schema.schema.properties, 'schema');

    assert.deepEqual(
      offenders,
      [],
      `these descriptions contain markdown, which the config UI shows literally: ${offenders.join(', ')}`
    );
  });
});
