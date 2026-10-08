// Unit test for lib/buddyHub.js's dbLinks.save — mocks ../db (no real Postgres).
// Regression for: hub reuses the same link_id for repeat links of the same hub account to this
// app (e.g. unlink then relink), so a stale row can belong to a DIFFERENT local user and the
// INSERT hit the link_id primary key. save() must clear by link_id too, not just user_id.
// Usage: node test/test_buddy_hub_links.js
'use strict';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

const dbPath = require.resolve('../db.js');
const hubPath = require.resolve('../lib/buddyHub.js');

// In-memory fake table for unglutened.omni_links.
let rows = [];
const T = { omniLinks: 'unglutened.omni_links', omniPushed: 'unglutened.omni_pushed' };
async function q(text, params = []) {
  if (text.startsWith('DELETE FROM unglutened.omni_links WHERE user_id = $1 OR link_id = $2')) {
    const [userId, linkId] = params;
    rows = rows.filter((r) => !(r.user_id === userId || r.link_id === linkId));
    return [];
  }
  if (text.startsWith('DELETE FROM unglutened.omni_pushed')) return [];
  if (text.startsWith('INSERT INTO unglutened.omni_links')) {
    const [link_id, user_id, token, signing_key] = params;
    if (rows.some((r) => r.link_id === link_id)) throw new Error('duplicate key value violates unique constraint "omni_links_pkey"');
    rows.push({ link_id, user_id, token, signing_key, status: 'active' });
    return [];
  }
  throw new Error('unexpected query: ' + text);
}

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { q, T } };
delete require.cache[hubPath];
const { dbLinks } = require('../lib/buddyHub.js');

async function main() {
  // First link: hub account -> local user 2, link_id L1.
  await dbLinks.save({ link_id: 'L1', user_id: 2, token: 't1', signing_key: 'k1' });
  ok('first save stores the row', rows.length === 1 && rows[0].user_id === 2);

  // Unlink on the hub side never tells this Buddy to delete the row (today's real-world gap);
  // simulate that by leaving the L1 row in place, then relinking the SAME hub account (hub
  // reuses link_id L1) to a DIFFERENT local user (5) — this must not throw a PK collision.
  await dbLinks.save({ link_id: 'L1', user_id: 5, token: 't2', signing_key: 'k2' });
  ok('relink with a reused link_id for a different user does not throw / duplicate', rows.length === 1 && rows[0].user_id === 5 && rows[0].link_id === 'L1');

  // Re-linking the same user again (idempotent case from the existing suite) still works.
  await dbLinks.save({ link_id: 'L1', user_id: 5, token: 't3', signing_key: 'k3' });
  ok('idempotent re-save for the same user keeps exactly one row', rows.length === 1 && rows[0].token === 't3');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
