// Unit test for the shared-vault OpenRouter key resolver in lib/openrouter.js.
// Standalone — no server, no network, no paid OpenRouter calls.
// Usage: node test/test_openrouter_key_resolver.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const modPath = require.resolve('../lib/openrouter.js');

// Test 1: env var wins when set.
delete process.env.OPENROUTER_API_KEY_FILE;
process.env.OPENROUTER_API_KEY = 'already-set-value';
delete require.cache[modPath];
ok('env var wins when present', require('../lib/openrouter.js').resolveOpenRouterKey() === 'already-set-value');

// Test 2: falls back to OPENROUTER_API_KEY_FILE when env unset.
delete process.env.OPENROUTER_API_KEY;
const tmpFile = path.join(os.tmpdir(), 'unglutened_test_key_' + process.pid + '.txt');
fs.writeFileSync(tmpFile, 'sk-or-v1-fake-test-key\n', 'utf8');
process.env.OPENROUTER_API_KEY_FILE = tmpFile;
delete require.cache[modPath];
ok('falls back to OPENROUTER_API_KEY_FILE', require('../lib/openrouter.js').resolveOpenRouterKey() === 'sk-or-v1-fake-test-key');
fs.unlinkSync(tmpFile);
delete process.env.OPENROUTER_API_KEY_FILE;

// Test 3: falls back to the shared vault file when nothing else is set.
delete require.cache[modPath];
const key = require('../lib/openrouter.js').resolveOpenRouterKey();
ok('vault fallback returns a plausible key or empty', key === '' || key.startsWith('sk-or-v1-'), 'length=' + key.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
