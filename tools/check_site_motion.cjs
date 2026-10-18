// Run: node tools/check_site_motion.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const script = readFileSync(join(__dirname, "../site/public/motion.js"), "utf8");

for (const [supported, reduced] of [[false, false], [true, true], [true, false]]) {
  let callback;
  const classes = new Set();
  const element = { classList: { add: (name) => classes.add(name) } };
  const observed = new Set();
  class IntersectionObserver {
    constructor(fn) { callback = fn; }
    observe(target) { observed.add(target); }
    unobserve(target) { observed.delete(target); }
  }
  runInNewContext(script, {
    window: { ...(supported ? { IntersectionObserver } : {}), matchMedia: () => ({ matches: reduced }) },
    IntersectionObserver,
    document: { querySelectorAll: () => [element] },
  });
  assert.equal(observed.size, supported && !reduced ? 1 : 0);
  assert.equal(classes.size, 0);
  if (callback) {
    callback([{ target: element, isIntersecting: false }]);
    assert.equal(classes.size, 0);
    assert.equal(observed.size, 1);
    callback([{ target: element, isIntersecting: true }]);
    assert.ok(classes.has("motion-enter"));
    assert.equal(observed.size, 0);
  }
}
console.log("Validated one-shot motion, reduced preference and unsupported observer");
