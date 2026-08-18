'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

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

  //the prerequisite users kept missing in v1.1.0: it is only stated in the
  //README, which the config UI never shows them
  it('states the aioairctrl prerequisite in the config UI header', () => {
    assert.match(schema.headerDisplay, /aioairctrl/);
    assert.match(schema.headerDisplay, /pipx install aioairctrl/);
    assert.match(schema.headerDisplay, /Homebridge/);
  });

  //"Devices" rendered twice, once from the layout section and once from the
  //array's own schema title
  it('does not render the devices heading twice', () => {
    const trail = findLayoutPath(schema.layout, 'devices');
    const titles = trail.map((node) => node.title).filter(Boolean);

    assert.deepEqual([...new Set(titles)], titles, 'a devices layout ancestor repeats the array title');

    const sectionTitles = new Set(titles);
    const schemaTitle = schema.schema.properties.devices.title;

    assert.ok(
      !schemaTitle || !sectionTitles.has(schemaTitle),
      `the devices array's schema title '${schemaTitle}' is repeated by a layout section`
    );
  });

  //a plain array stacks devices with nothing to tell them apart; tabarray is
  //what gives each one a tab labelled from its name
  it('renders each device as a titled tab', () => {
    const item = findLayoutItem(schema.layout, 'devices');

    assert.equal(item.type, 'tabarray');
    assert.match(item.title, /\{\{.*value\.name.*\}\}/);
  });
});
