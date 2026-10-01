import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtension,
  parseExtensions,
  serializeExtension,
  serializeExtensions,
  selectDeflate,
  buildOffer,
} from '../src/core.js';

// --- parseExtension ----------------------------------------------------------

test('parseExtension parses name with no params', () => {
  assert.deepEqual(parseExtension('permessage-deflate'), {
    name: 'permessage-deflate',
    params: {},
  });
});

test('parseExtension parses name with one param', () => {
  assert.deepEqual(parseExtension('permessage-deflate; server_no_context_takeover'), {
    name: 'permessage-deflate',
    params: { server_no_context_takeover: '' },
  });
});

test('parseExtension trims whitespace around name and params', () => {
  assert.deepEqual(
    parseExtension('  permessage-deflate  ;  server_max_window_bits = 10  '),
    { name: 'permessage-deflate', params: { server_max_window_bits: '10' } },
  );
});

test('parseExtension unwraps quoted-string values', () => {
  assert.deepEqual(parseExtension('ext; key="value with spaces"'), {
    name: 'ext',
    params: { key: 'value with spaces' },
  });
});

test('parseExtension rejects empty segment', () => {
  assert.throws(() => parseExtension(''), /Empty extension segment/);
});

test('parseExtension rejects duplicate parameter names', () => {
  assert.throws(
    () => parseExtension('ext; a=1; a=2'),
    /Duplicate parameter/,
  );
});

test('parseExtension rejects unterminated quoted-string', () => {
  assert.throws(
    () => parseExtension('ext; key="oops'),
    /Unterminated quoted-string/,
  );
});

test('parseExtension rejects invalid token characters in name', () => {
  assert.throws(() => parseExtension('bad name'), /Invalid extension name/);
});

// --- parseExtensions ---------------------------------------------------------

test('parseExtensions returns empty array for empty header', () => {
  assert.deepEqual(parseExtensions(''), []);
});

test('parseExtensions splits on commas and preserves order', () => {
  const result = parseExtensions('permessage-deflate; server_no_context_takeover, other-ext; x=1');
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'permessage-deflate');
  assert.equal(result[1].name, 'other-ext');
  assert.equal(result[1].params.x, '1');
});

test('parseExtensions skips empty segments from trailing comma', () => {
  const result = parseExtensions('permessage-deflate,');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'permessage-deflate');
});

// --- serializeExtension / serializeExtensions -------------------------------

test('serializeExtension round-trips a simple extension', () => {
  const ext = { name: 'permessage-deflate', params: { server_no_context_takeover: '' } };
  assert.equal(serializeExtension(ext), 'permessage-deflate; server_no_context_takeover');
});

test('serializeExtension quotes values that are not clean tokens', () => {
  assert.equal(
    serializeExtension({ name: 'ext', params: { key: 'has space' } }),
    'ext; key="has space"',
  );
});

test('serializeExtensions joins multiple with comma-space', () => {
  assert.equal(
    serializeExtensions([
      { name: 'a', params: {} },
      { name: 'b', params: {} },
    ]),
    'a, b',
  );
});

// --- selectDeflate -----------------------------------------------------------

test('selectDeflate returns null when no permessage-deflate offer present', () => {
  assert.equal(selectDeflate('other-ext'), null);
});

test('selectDeflate returns null for empty header', () => {
  assert.equal(selectDeflate(''), null);
});

test('selectDeflate accepts a bare offer', () => {
  assert.equal(selectDeflate('permessage-deflate'), 'permessage-deflate');
});

test('selectDeflate echoes server_no_context_takeover', () => {
  assert.equal(
    selectDeflate('permessage-deflate; server_no_context_takeover'),
    'permessage-deflate; server_no_context_takeover',
  );
});

test('selectDeflate echoes both no_context_takeover flags', () => {
  assert.equal(
    selectDeflate('permessage-deflate; server_no_context_takeover; client_no_context_takeover'),
    'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
  );
});

test('selectDeflate echoes valid server_max_window_bits', () => {
  assert.equal(
    selectDeflate('permessage-deflate; server_max_window_bits=10'),
    'permessage-deflate; server_max_window_bits=10',
  );
});

test('selectDeflate rejects server_max_window_bits below 9', () => {
  assert.equal(selectDeflate('permessage-deflate; server_max_window_bits=8'), null);
});

test('selectDeflate rejects server_max_window_bits above 15', () => {
  assert.equal(selectDeflate('permessage-deflate; server_max_window_bits=16'), null);
});

test('selectDeflate rejects non-numeric server_max_window_bits', () => {
  assert.equal(selectDeflate('permessage-deflate; server_max_window_bits=big'), null);
});

test('selectDeflate accepts bare client_max_window_bits hint', () => {
  assert.equal(
    selectDeflate('permessage-deflate; client_max_window_bits'),
    'permessage-deflate; client_max_window_bits',
  );
});

test('selectDeflate echoes valued client_max_window_bits', () => {
  assert.equal(
    selectDeflate('permessage-deflate; client_max_window_bits=12'),
    'permessage-deflate; client_max_window_bits=12',
  );
});

test('selectDeflate rejects unknown parameters', () => {
  assert.equal(selectDeflate('permessage-deflate; mystery_param=1'), null);
});

test('selectDeflate rejects server_no_context_takeover with a value', () => {
  assert.equal(selectDeflate('permessage-deflate; server_no_context_takeover=1'), null);
});

test('selectDeflate picks the first permessage-deflate offer only', () => {
  // The second offer has an unknown param; since we only consider the first,
  // the second is irrelevant and the first (bare) offer is accepted.
  assert.equal(
    selectDeflate('permessage-deflate, permessage-deflate; mystery=1'),
    'permessage-deflate',
  );
});

// --- buildOffer --------------------------------------------------------------

test('buildOffer with no options produces bare offer', () => {
  assert.equal(buildOffer(), 'permessage-deflate');
});

test('buildOffer with serverNoContextTakeover', () => {
  assert.equal(
    buildOffer({ serverNoContextTakeover: true }),
    'permessage-deflate; server_no_context_takeover',
  );
});

test('buildOffer with serverMaxWindowBits', () => {
  assert.equal(
    buildOffer({ serverMaxWindowBits: 12 }),
    'permessage-deflate; server_max_window_bits=12',
  );
});

test('buildOffer with clientMaxWindowBits=true sends bare param', () => {
  assert.equal(
    buildOffer({ clientMaxWindowBits: true }),
    'permessage-deflate; client_max_window_bits',
  );
});

test('buildOffer with clientMaxWindowBits=14 sends valued param', () => {
  assert.equal(
    buildOffer({ clientMaxWindowBits: 14 }),
    'permessage-deflate; client_max_window_bits=14',
  );
});

test('buildOffer rejects out-of-range serverMaxWindowBits', () => {
  assert.throws(() => buildOffer({ serverMaxWindowBits: 8 }), /9\.\.15/);
  assert.throws(() => buildOffer({ serverMaxWindowBits: 16 }), /9\.\.15/);
});

test('buildOffer rejects non-integer serverMaxWindowBits', () => {
  assert.throws(() => buildOffer({ serverMaxWindowBits: 10.5 }), /9\.\.15/);
});

test('buildOffer combined options', () => {
  assert.equal(
    buildOffer({
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      serverMaxWindowBits: 10,
      clientMaxWindowBits: 10,
    }),
    'permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10; client_max_window_bits=10',
  );
});
