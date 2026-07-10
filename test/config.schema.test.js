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
});
