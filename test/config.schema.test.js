'use strict';

//Drift guards for config.schema.json, the file the Homebridge UI renders. They
//check that the schema keeps up with the code: the model typeahead offers every
//model that has a mapping, and the setup text quotes the command preflight.js
//actually runs. A failure here means the schema is stale, not that the check is
//too strict. docs.test.js does the same job for README.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { DEFAULT_BINARY, PROBE_ARGS } = require('../src/utils/preflight');

const { mappedModels, deviceOptions, lackedOptions, resolveModel } = require('../src/accessories/accessories.models');

//The condition config.schema.json carries on a device option: shown when it is
//already switched on, or when the model field does not name a model that lacks
//it. The model is read the way normaliseModel reads it (case, spaces and the
//regional /suffix ignored). An error shows the option, as does an unmapped model.
const optionCondition = (option, lacking) =>
  'try { var device = model.devices[arrayIndices[0]]; ' +
  `if (device.${option}) { return true; } ` +
  "var key = String(device.model || '').trim().toUpperCase().replace(/\\s+/g, '').split('/')[0]; " +
  `return ${JSON.stringify(lacking)}.indexOf(key) === -1; ` +
  '} catch (e) { return true; }';

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
  for (const key of ['devices[].port', 'devices[].refreshInterval', 'devices[].filterChangeThreshold']) {
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

  //a pre-filled 000000 lands in every config the settings panel saves, where it
  //cannot be told apart from a serial number the user chose
  it('offers no default serial number', () => {
    const { serialNumber } = schema.schema.properties.devices.items.properties;

    assert.equal(serialNumber.default, undefined, 'devices[].serialNumber must not pre-fill a value');
    assert.equal(serialNumber.placeholder, '000000');
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

  //Name and Model are the pair this schema exists to tell apart, so they have
  //to render together. A condition on model takes it off screen for a device
  //that is not active, leaving a tab that asks only for a name, which is the
  //confusion this whole change set is about.
  it('shows the model field alongside the name, whatever the device says', () => {
    const properties = schema.schema.properties.devices.items.properties;

    assert.equal(properties.name.condition, undefined, 'devices[].name must not be conditional');
    assert.equal(
      properties.model.condition,
      undefined,
      'devices[].model must not be conditional; it is the field that selects the speed and register maps'
    );
  });

  //Asserting the header contains the words it was written with would only
  //restate the schema. What is worth guarding is that the instructions stay
  //true of how the plugin actually behaves, and stay in step with the README:
  //copy in two places, describing code in a third, is what drifts.
  //With a layout present the Homebridge UI ignores a condition on a schema
  //property and takes it from the layout item instead, so one written on the
  //property silently never applies. 2.3.0-beta.1 shipped #69 that way.
  it('puts every condition on a layout item, where the UI reads it', () => {
    const misplaced = [];
    const walk = (node, trail) => {
      if (node && typeof node === 'object') {
        if (Object.prototype.hasOwnProperty.call(node, 'condition')) {
          misplaced.push(trail);
        }
        for (const [key, value] of Object.entries(node)) {
          walk(value, `${trail}.${key}`);
        }
      }
    };
    walk(schema.schema, 'schema');
    assert.deepEqual(misplaced, [], 'move these conditions onto their layout items');
  });

  //These five carried conditions on their schema properties that never
  //applied. Applying them would hide a setting that still takes effect:
  //cliDebug and extendedError keep shaping the log with debug or error off,
  //and host is required even on an inactive device. So they stay unconditional.
  it('keeps the log switches and the connection fields on show', () => {
    for (const key of ['cliDebug', 'extendedError', 'devices[].host', 'devices[].port', 'devices[].refreshInterval']) {
      //a plain string entry is a field with no options, so no condition
      const asString = JSON.stringify(schema.layout).includes(`"${key}"`);
      const item = findLayoutItem(schema.layout, key);
      assert.ok(item || asString, `${key} is missing from the layout`);
      assert.equal(item && item.condition, undefined, `${key} must not be conditional`);
    }
  });

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

  //The Homebridge plugin checks compile the schema with Ajv, which rejects the
  //old per-field `required: true`; JSON Schema wants a list on the object
  it('marks required fields with a required list on the object, never a boolean on the field', () => {
    const booleans = [];
    const walk = (node, at) => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${at}[${i}]`));
      } else if (node && typeof node === 'object') {
        if (typeof node.required === 'boolean') {
          booleans.push(at);
        }
        for (const [key, child] of Object.entries(node)) {
          walk(child, `${at}.${key}`);
        }
      }
    };
    walk(schema.schema, 'schema');
    assert.deepEqual(booleans, []);

    assert.deepEqual(schema.schema.required, ['devices']);
    assert.deepEqual(schema.schema.properties.devices.items.required, ['name', 'model', 'host']);
  });
});

//Issue #69: each device option is offered only where it can do something. The
//schema cannot load the plugin, so each option's condition carries its own copy
//of the models that lack it, taken from the capability table. These tests run
//that condition the way the Homebridge UI does and compare the answer with the
//runtime's, so a mapping change that is not copied into the schema fails here.
describe('config.schema hides device options a model cannot use', () => {
  //the Homebridge UI reads a condition from the layout item, not the schema
  //property, once the schema has a layout (2.3.0-beta.1 hid nothing for that)
  const conditionOf = (option) => {
    const item = findLayoutItem(schema.layout, `devices[].${option}`);
    return item && item.condition;
  };

  //what the Homebridge UI evaluates: a function of the whole form model and
  //the indices of the array items the field sits in
  const visible = (option, device, rewrite = (body) => body) => {
    const condition = conditionOf(option);
    assert.ok(condition && condition.functionBody, `${option} has no condition`);
    const run = new Function('model', 'arrayIndices', rewrite(condition.functionBody));
    return run({ devices: [{ active: true }, device] }, [1]);
  };

  //the models whose entry lists the option, which is what its condition hides it for
  const lackingModels = (option) => mappedModels.filter((key) => lackedOptions(key).includes(option));

  it('copies, for every option, exactly the models the capability table says lack it', () => {
    for (const option of deviceOptions) {
      assert.equal(
        conditionOf(option) && conditionOf(option).functionBody,
        optionCondition(option, lackingModels(option)),
        `config.schema.json: ${option}'s condition no longer matches the capability table; replace it with the expected functionBody`
      );
    }
  });

  it('hides an option for every mapped model that lacks it, and shows it for the rest', () => {
    for (const option of deviceOptions) {
      for (const key of mappedModels) {
        assert.equal(visible(option, { model: key }), !lackedOptions(key).includes(option), `${option} on ${key}`);
      }
    }
  });

  it('reads the model field the way the runtime does', () => {
    for (const typed of ['AC0850/31', 'ac0850', ' AC 0850 ', 'Ac0850/11']) {
      assert.equal(resolveModel({ model: typed }).key, 'AC0850', typed);
      assert.equal(visible('sleepSpeed', { model: typed }), false, typed);
      assert.equal(visible('allergicFunc', { model: typed }), false, typed);
      assert.equal(visible('preFilter', { model: typed }), true, typed);
    }
  });

  //Before it runs a condition the Homebridge UI rewrites its property reads
  //to optional chaining. Older UI versions did it by splitting on every dot,
  //which breaks a regular expression containing one. Both rewrites, as the
  //UI's @ng-formworks/core patch has them, must leave the answer unchanged.
  it('gives the same answer after either of the UI rewrites', () => {
    const rewrites = {
      current: (body) =>
        body.replace(/([a-zA-Z_$])(\[)/g, '$1?.[').replace(/([a-zA-Z_$\]])(\.)(?=[a-zA-Z_$[])/g, '$1?.'),
      legacy: (body) =>
        body
          .replace(/\[/g, '.[')
          .split('.')
          .join('?.')
          .replace(/\?\?\./g, '?')
          .replace(/(\?)(\.\[)/g, '['),
    };
    for (const [name, rewrite] of Object.entries(rewrites)) {
      for (const option of deviceOptions) {
        for (const model of [...mappedModels, 'AC0850/31', 'ac0850', 'AC9999', '']) {
          assert.equal(
            visible(option, { model }, rewrite),
            visible(option, { model }),
            `${option} on ${JSON.stringify(model)} after the ${name} rewrite`
          );
        }
      }
    }
  });

  it('keeps every option for a model the plugin does not map, or none typed', () => {
    for (const device of [{ model: 'AC9999' }, { model: '' }, {}, { model: null }]) {
      for (const option of deviceOptions) {
        assert.equal(visible(option, device), true, `${option} on ${JSON.stringify(device)}`);
      }
    }
  });

  //The runtime falls back to a model ID in the device name. The form does not,
  //which can only leave an option on show that does nothing, never hide one
  //that works: whatever it hides, the runtime leaves out too.
  it('never hides an option the runtime would honour', () => {
    const devices = [
      ...mappedModels.map((key) => ({ model: key })),
      { name: 'AC0850 bedroom' },
      { model: 'AC9999', name: 'AC0651' },
      { model: 'AC0850', name: 'AC3829' },
    ];
    for (const device of devices) {
      for (const option of deviceOptions) {
        if (!visible(option, device)) {
          assert.ok(lackedOptions(resolveModel(device).key).includes(option), `${option} on ${JSON.stringify(device)}`);
        }
      }
    }
  });

  //hiding a field leaves its value in config.json, and the runtime warns at
  //every start about an option it leaves out, so an option already switched on
  //stays in sight for the user to switch off
  it('keeps an option that is already switched on in sight', () => {
    for (const option of deviceOptions) {
      assert.equal(visible(option, { model: 'AC0651', [option]: true }), true, option);
    }
  });

  it('shows the option rather than failing when the form model is not there yet', () => {
    const run = new Function('model', 'arrayIndices', conditionOf('sleepSpeed').functionBody);
    assert.equal(run(undefined, [0]), true);
    assert.equal(run({ devices: [] }, [0]), true);
  });
});
