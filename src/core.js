/**
 * Core parsing and serialization for the permessage-deflate WebSocket extension.
 *
 * The wire format is defined by RFC 7692 §7 (permessage-deflate) and §9 (formal
 * grammar for Sec-WebSocket-Extensions). The grammar is:
 *
 *   extension = extension-name *( ";" extension-param )
 *   extension-name = token
 *   extension-param = param-name [ "=" param-value ]
 *   param-name = token
 *   param-value = token | quoted-string
 *
 * Multiple extensions are comma-separated. We deliberately implement a
 * minimal-but-correct subset: we parse only what RFC 7692 requires and we do
 * NOT try to be a generic Sec-WebSocket-Extensions parser. This keeps the
 * surface area small and the behaviour predictable.
 */

/**
 * Parse a single extension string (one comma-separated segment) into a name and
 * a parameter map.
 *
 * We split on ";" then on the first "=". Whitespace around names, params, and
 * values is trimmed per RFC 7230 §3.2.3 (OWS is optional whitespace). Quoted
 * strings are unwrapped but their internal content is taken literally — we do
 * not process quoted-pair escapes because permessage-deflate never produces
 * them and accepting them would only widen the attack surface.
 *
 * Duplicate parameter names within a single offer are rejected. RFC 7692 does
 * not define precedence for duplicates and a server MUST NOT silently pick one;
 * rejecting is the safe, spec-aligned choice.
 *
 * @param {string} segment - A single extension segment (no commas).
 * @returns {{name: string, params: Record<string, string>}}
 * @throws {Error} if the segment is malformed.
 */
export function parseExtension(segment) {
  const trimmed = segment.trim();
  if (trimmed === '') {
    throw new Error('Empty extension segment');
  }

  const parts = trimmed.split(';');
  const name = parts[0].trim();
  if (name === '') {
    throw new Error('Missing extension name');
  }
  // RFC 7230 token: VCHAR except delimiters. We validate loosely — reject
  // anything with whitespace or control chars inside the token, since the
  // trim above already handled surrounding OWS.
  if (!/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(name)) {
    throw new Error(`Invalid extension name: ${JSON.stringify(name)}`);
  }

  /** @type {Record<string, string>} */
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i];
    const eq = raw.indexOf('=');
    let paramName;
    let paramValue;
    if (eq === -1) {
      paramName = raw.trim();
      paramValue = '';
    } else {
      paramName = raw.slice(0, eq).trim();
      paramValue = raw.slice(eq + 1).trim();
    }

    if (paramName === '') {
      throw new Error(`Empty parameter name in segment: ${JSON.stringify(segment)}`);
    }
    if (!/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(paramName)) {
      throw new Error(`Invalid parameter name: ${JSON.stringify(paramName)}`);
    }

    if (paramValue.startsWith('"')) {
      // Quoted-string. Must end with a quote and contain no unescaped quotes
      // in the middle. We do not unescape quoted-pair ("\...") because
      // permessage-deflate never emits it; rejecting is safer than guessing.
      if (!paramValue.endsWith('"') || paramValue.length < 2) {
        throw new Error(`Unterminated quoted-string: ${JSON.stringify(paramValue)}`);
      }
      const inner = paramValue.slice(1, -1);
      if (inner.includes('"')) {
        throw new Error(`Invalid quote inside quoted-string: ${JSON.stringify(paramValue)}`);
      }
      paramValue = inner;
    } else if (paramValue !== '') {
      if (!/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(paramValue)) {
        throw new Error(`Invalid token parameter value: ${JSON.stringify(paramValue)}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(params, paramName)) {
      throw new Error(`Duplicate parameter: ${JSON.stringify(paramName)}`);
    }
    params[paramName] = paramValue;
  }

  return { name, params };
}

/**
 * Parse a full Sec-WebSocket-Extensions header value into a list of
 * {name, params} objects, preserving order. Only segments whose name is
 * "permessage-deflate" are relevant to this library, but we return all so
 * callers can inspect the full negotiation if needed.
 *
 * @param {string} header - Raw header value (may be empty/undefined-ish).
 * @returns {Array<{name: string, params: Record<string, string>}>}
 */
export function parseExtensions(header) {
  if (header === null || header === undefined || header === '') {
    return [];
  }
  const segments = header.split(',');
  const result = [];
  for (const seg of segments) {
    if (seg.trim() === '') {
      // Empty segments (e.g. trailing comma) are ignored rather than rejected.
      // RFC 7692 does not address this; being lenient here matches common
      // server implementations and avoids failing on slightly sloppy headers.
      continue;
    }
    result.push(parseExtension(seg));
  }
  return result;
}

/**
 * Serialize a single extension back to its wire form.
 *
 * @param {{name: string, params: Record<string, string>}} ext
 * @returns {string}
 */
export function serializeExtension(ext) {
  let out = ext.name;
  for (const [k, v] of Object.entries(ext.params)) {
    if (v === '') {
      out += `; ${k}`;
    } else if (/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(v)) {
      out += `; ${k}=${v}`;
    } else {
      // Quote if not a clean token. Escape any double-quote or backslash.
      const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      out += `; ${k}="${escaped}"`;
    }
  }
  return out;
}

/**
 * Serialize a list of extensions into a comma-joined header value.
 *
 * @param {Array<{name: string, params: Record<string, string>}>} list
 * @returns {string}
 */
export function serializeExtensions(list) {
  return list.map(serializeExtension).join(', ');
}

/**
 * Select the best permessage-deflate offer from a client's Sec-WebSocket-Extensions
 * header and return the response string to send back, or null if the extension
 * should not be used.
 *
 * Selection policy (stated plainly so there is no ambiguity):
 *   - Only the FIRST permessage-deflate offer is considered. RFC 7692 permits a
 *     client to send multiple offers, but a server selecting the Nth offer is
 *     vanishingly rare in practice and supporting it adds combinatorial
 *     complexity for no real-world benefit. We pick the first and stop.
 *   - If the offer contains parameters we do not recognize, we REJECT the
 *     extension entirely rather than silently ignoring them. This is stricter
 *     than the RFC minimum but prevents a client from believing a parameter
 *     was honored when it was dropped.
 *   - server_no_context_takeover and client_no_context_takeover are accepted
 *     and echoed. server_max_window_bits is accepted only if within [9, 15];
 *     the response echoes the client's value (we do not down-negotiate).
 *     client_max_window_bits, if present, is echoed as-is (it is a hint from
 *     the client about its own capability; the server may include it to cap
 *     the client, but we simply acknowledge it).
 *
 * @param {string} header - The raw Sec-WebSocket-Extensions header value.
 * @returns {string|null} The response header value, or null to decline.
 */
export function selectDeflate(header) {
  const offers = parseExtensions(header);
  const offer = offers.find((o) => o.name === 'permessage-deflate');
  if (!offer) {
    return null;
  }

  const known = new Set([
    'server_no_context_takeover',
    'client_no_context_takeover',
    'server_max_window_bits',
    'client_max_window_bits',
  ]);
  for (const key of Object.keys(offer.params)) {
    if (!known.has(key)) {
      // Unknown parameter: reject the whole extension. See policy note above.
      return null;
    }
  }

  /** @type {Record<string, string>} */
  const responseParams = {};

  if (offer.params['server_no_context_takeover'] !== undefined) {
    // Must have no value. If a value is present, the offer is malformed.
    if (offer.params['server_no_context_takeover'] !== '') {
      return null;
    }
    responseParams['server_no_context_takeover'] = '';
  }

  if (offer.params['client_no_context_takeover'] !== undefined) {
    if (offer.params['client_no_context_takeover'] !== '') {
      return null;
    }
    responseParams['client_no_context_takeover'] = '';
  }

  if (offer.params['server_max_window_bits'] !== undefined) {
    const bits = offer.params['server_max_window_bits'];
    // RFC 7692 §7.1.2.1: value must be a decimal integer 9..15.
    if (!/^[0-9]+$/.test(bits)) {
      return null;
    }
    const n = Number.parseInt(bits, 10);
    if (n < 9 || n > 15) {
      return null;
    }
    responseParams['server_max_window_bits'] = String(n);
  }

  if (offer.params['client_max_window_bits'] !== undefined) {
    // The client may send this with no value (a hint) or with a value 9..15.
    const bits = offer.params['client_max_window_bits'];
    if (bits === '') {
      // Acknowledge without constraining. We do not add a value.
      responseParams['client_max_window_bits'] = '';
    } else {
      if (!/^[0-9]+$/.test(bits)) {
        return null;
      }
      const n = Number.parseInt(bits, 10);
      if (n < 9 || n > 15) {
        return null;
      }
      responseParams['client_max_window_bits'] = String(n);
    }
  }

  return serializeExtension({ name: 'permessage-deflate', params: responseParams });
}

/**
 * Build a client-side permessage-deflate offer string from an options object.
 *
 * This is the inverse of selectDeflate from the client's perspective: it lets
 * a client construct an offer with the parameters it wants, validated up front.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.serverNoContextTakeover=false]
 * @param {boolean} [opts.clientNoContextTakeover=false]
 * @param {number} [opts.serverMaxWindowBits] - 9..15
 * @param {number|true} [opts.clientMaxWindowBits] - 9..15, or true to send the
 *   bare parameter (client hint with no value).
 * @returns {string}
 */
export function buildOffer(opts = {}) {
  const params = {};
  if (opts.serverNoContextTakeover) {
    params['server_no_context_takeover'] = '';
  }
  if (opts.clientNoContextTakeover) {
    params['client_no_context_takeover'] = '';
  }
  if (opts.serverMaxWindowBits !== undefined) {
    const n = opts.serverMaxWindowBits;
    if (!Number.isInteger(n) || n < 9 || n > 15) {
      throw new Error(`serverMaxWindowBits must be an integer 9..15, got ${String(n)}`);
    }
    params['server_max_window_bits'] = String(n);
  }
  if (opts.clientMaxWindowBits !== undefined) {
    if (opts.clientMaxWindowBits === true) {
      params['client_max_window_bits'] = '';
    } else {
      const n = opts.clientMaxWindowBits;
      if (!Number.isInteger(n) || n < 9 || n > 15) {
        throw new Error(`clientMaxWindowBits must be true or an integer 9..15, got ${String(n)}`);
      }
      params['client_max_window_bits'] = String(n);
    }
  }
  return serializeExtension({ name: 'permessage-deflate', params });
}
