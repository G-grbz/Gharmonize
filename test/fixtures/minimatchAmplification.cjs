const assert = require('node:assert/strict');
const { Minimatch } = require('minimatch');

// A separate process bounds both time and memory if a dependency regresses.
// On 10.2.6 even eight segments expand to 256 entries despite a cap of eight.
// Do not run the larger sample against an unpatched matcher in this process.
const small = new Minimatch(Array(8).fill('**/../a/b').join('/'), {
  optimizationLevel: 2, braceExpandMax: 8
});
assert.ok(small.set.length <= 8, `Unexpected amplification: ${small.set.length}`);
const large = new Minimatch(Array(30).fill('**/../a/b').join('/'), {
  optimizationLevel: 2, braceExpandMax: 64
});
assert.ok(large.set.length <= 64);
const ordinary = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
assert.equal(ordinary.match('../a/b/../c/d'), true);
assert.equal(ordinary.match('x/a/b/y/c/d'), true);
console.log(JSON.stringify({ small: small.set.length, large: large.set.length, node: process.version }));
