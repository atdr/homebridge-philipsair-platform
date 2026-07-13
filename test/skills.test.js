'use strict';

//Drift guard for the agent skills in .claude/skills, in the spirit of
//docs.test.js: the skills anchor their claims to real files, so a rename or
//move under src/ or test/ must fail here instead of silently orphaning the
//skill. Everything not mechanically checkable (log strings, timings,
//rationale) is covered by each skill's "Provenance and maintenance" commands.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const skillsDir = path.join(root, '.claude', 'skills');

const skills = fs
  .readdirSync(skillsDir)
  .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
  .map((name) => ({ name, body: fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8') }));

describe('skills', () => {
  it('finds the skills library', () => {
    assert.ok(skills.length > 0, 'no SKILL.md files found under .claude/skills');
  });

  it('has frontmatter whose name matches the directory', () => {
    for (const { name, body } of skills) {
      const frontmatter = body.match(/^---\n([\s\S]+?)\n---\n/);
      assert.ok(frontmatter, `${name}/SKILL.md has no YAML frontmatter`);

      const skillName = frontmatter[1].match(/^name: (.+)$/m);
      const description = frontmatter[1].match(/^description: (.+)$/m);

      assert.equal(skillName && skillName[1], name, `${name}/SKILL.md frontmatter name does not match its directory`);
      assert.ok(description && description[1].trim(), `${name}/SKILL.md frontmatter has no description`);
    }
  });

  it('references only src/ and test/ paths that exist', () => {
    for (const { name, body } of skills) {
      const tokens = body.match(/(?<![A-Za-z0-9_-])(?:src|test)\/[A-Za-z0-9_./-]+/g) || [];

      for (const token of new Set(tokens)) {
        assert.ok(
          fs.existsSync(path.join(root, token)),
          `${name}/SKILL.md references '${token}', which does not exist — update the skill or restore the file`
        );
      }
    }
  });
});
