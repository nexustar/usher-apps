// A describe/it runner for GJS.
//
// jasmine-gjs would be the obvious choice, but it is not packaged on every
// distribution and building it from source is a heavier ask than this file.
// What the suites need is structure, async support, and a failure message that
// names the expectation — all of which fits here.

import GLib from 'gi://GLib';

const suites = [];
let current = null;

export function describe(name, body) {
  current = { name, specs: [], before: null, after: null };
  suites.push(current);
  body();
  current = null;
}

export function it(name, body) {
  current.specs.push({ name, body });
}

export function beforeAll(body) {
  current.before = body;
}

export function afterAll(body) {
  current.after = body;
}

export function sleep(ms) {
  return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
  }));
}

// Waits for a condition that a GLib main-loop callback will eventually make
// true — a texture arriving, a widget being laid out — instead of guessing at
// a sleep long enough to cover it.
export async function until(name, predicate, timeoutMs = 8000) {
  const deadline = GLib.get_monotonic_time() / 1000 + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (GLib.get_monotonic_time() / 1000 > deadline) {
      throw new Error(`timed out waiting for ${name}`);
    }
    await sleep(50);
  }
}

class Expectation {
  constructor(actual) {
    this.actual = actual;
  }

  _fail(message) {
    throw new Error(message);
  }

  toBe(expected) {
    if (this.actual !== expected) {
      this._fail(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(this.actual)}`);
    }
  }

  toEqual(expected) {
    const a = JSON.stringify(this.actual);
    const b = JSON.stringify(expected);
    if (a !== b) this._fail(`expected ${b}, got ${a}`);
  }

  toBeTruthy() {
    if (!this.actual) this._fail(`expected a truthy value, got ${JSON.stringify(this.actual)}`);
  }

  toBeFalsy() {
    if (this.actual) this._fail(`expected a falsy value, got ${JSON.stringify(this.actual)}`);
  }

  toContain(item) {
    const has = typeof this.actual === 'string'
      ? this.actual.includes(item)
      : Array.from(this.actual || []).includes(item);
    if (!has) this._fail(`expected ${JSON.stringify(this.actual)} to contain ${JSON.stringify(item)}`);
  }

  toHaveLength(n) {
    const len = this.actual?.length;
    if (len !== n) this._fail(`expected length ${n}, got ${len}`);
  }

  toBeWithin(low, high) {
    if (!(this.actual >= low && this.actual <= high)) {
      this._fail(`expected ${this.actual} to be within ${low}..${high}`);
    }
  }

  async toReject(matcher) {
    try {
      await this.actual;
    } catch (error) {
      if (matcher && !String(error.message || error).match(matcher)) {
        this._fail(`rejected with "${error.message}", which does not match ${matcher}`);
      }
      return error;
    }
    this._fail('expected a rejection, but it resolved');
    return null;
  }
}

export function expect(actual) {
  return new Expectation(actual);
}

// Runs every registered suite. Exits non-zero on the first failure so meson
// reports the test as failed.
export async function run() {
  let passed = 0;
  const failures = [];
  for (const suite of suites) {
    print(`\n${suite.name}`);
    if (suite.before) await suite.before();
    for (const spec of suite.specs) {
      try {
        await spec.body();
        passed++;
        print(`  ok   ${spec.name}`);
      } catch (error) {
        failures.push(`${suite.name} → ${spec.name}\n       ${error.message}`);
        print(`  FAIL ${spec.name}`);
        print(`       ${error.message}`);
      }
    }
    if (suite.after) await suite.after();
  }
  print(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    print('\nFailures:');
    for (const f of failures) print(`  ${f}`);
    imports.system.exit(1);
  }
}
