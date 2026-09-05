'use strict';

//Drift guard for the GitHub issue forms in .github/ISSUE_TEMPLATE. Their 'value' and
//'description' strings are rendered as comment Markdown, where GitHub turns every
//newline into a <br>. A paragraph hard wrapped in the YAML therefore arrives on the
//live form broken at the column it was wrapped at, and never reflows to the reader's
//width. So each paragraph inside a '|' literal block must be one line, however long.
//
//Nothing else catches this: the YAML is valid, prettier leaves literal blocks alone,
//and the damage is only visible on github.com. It shipped once already.
//
//Folded '>' blocks and plain multi-line scalars are exempt because YAML joins their
//lines with a space before GitHub ever sees them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const formsDir = path.join(__dirname, '..', '.github', 'ISSUE_TEMPLATE');
const forms = fs.readdirSync(formsDir).filter((name) => name.endsWith('.yml') && name !== 'config.yml');

//Every '<key>: |' literal block in the file, as the raw lines of its body. A block
//ends at the first non-blank line indented no further than the key that opened it.
const literalBlocks = (text) => {
  const lines = text.split('\n');
  const found = [];

  lines.forEach((line, index) => {
    const opener = /^(\s*)(value|description):\s*\|[-+]?\s*$/.exec(line);
    if (!opener) {
      return;
    }

    const indent = opener[1].length;
    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].trim() !== '' && lines[next].search(/\S/) <= indent) {
        break;
      }
      body.push(lines[next]);
    }
    found.push({ key: opener[2], line: index + 1, body });
  });

  return found;
};

describe('issue forms', () => {
  it('keeps every rendered paragraph on one line', () => {
    for (const form of forms) {
      const blocks = literalBlocks(fs.readFileSync(path.join(formsDir, form), 'utf8'));
      assert.notEqual(blocks.length, 0, `${form} has no literal block, so this guard is reading the wrong shape`);

      for (const block of blocks) {
        block.body.forEach((line, index) => {
          const previous = block.body[index - 1];
          assert.ok(
            line.trim() === '' || previous === undefined || previous.trim() === '',
            `${form}:${block.line + index + 1} continues a paragraph on a second line. GitHub renders the ` +
              `'${block.key}' break as a <br>, so unwrap the paragraph onto one line`
          );
        });
      }
    }
  });
});
