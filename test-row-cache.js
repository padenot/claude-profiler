// Checks the on-disk row cache: that an unchanged file is not summarized
// again, a changed one is, and a cached row comes back as it was summarized
// even after the caller changed the one it was handed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'row-cache-'));
process.env.XDG_CACHE_HOME = path.join(tmp, 'cache');
const { cachedMap, fileStamp } = require('./row-cache.js');

let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
  }
}

// Stands in for the worker pool, recording what it was asked to read.
let summarized = [];
const pool = {
  map: async (name, items) => {
    summarized.push(...items);
    return items.map(file => {
      const text = fs.readFileSync(file, 'utf8');
      return text ? { text } : null;
    });
  }
};
const options = { fileOf: file => file, stampOf: file => fileStamp(fs.statSync(file)) };
const cacheWritten = () => new Promise(resolve => setTimeout(resolve, 100));

const a = path.join(tmp, 'a.jsonl');
const b = path.join(tmp, 'b.jsonl');
const empty = path.join(tmp, 'empty.jsonl');
fs.writeFileSync(a, 'one');
fs.writeFileSync(b, 'two');
fs.writeFileSync(empty, '');

(async () => {
  const first = await cachedMap(pool, 'test', [a, b, empty], options);
  check('a first listing summarizes every file', summarized, [a, b, empty]);
  first[0].text = 'changed by the caller';
  await cacheWritten();

  summarized = [];
  check('a second listing comes from the cache, as summarized',
    await cachedMap(pool, 'test', [a, b, empty], options),
    [{ text: 'one' }, { text: 'two' }, null]);
  check('nothing is summarized again', summarized, []);

  fs.writeFileSync(b, 'two, longer');
  summarized = [];
  check('a changed file is summarized again',
    await cachedMap(pool, 'test', [a, b, empty], options),
    [{ text: 'one' }, { text: 'two, longer' }, null]);
  check('and only that file', summarized, [b]);

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
