# permessage-deflate negotiation

Parse and construct `permessage-deflate` extension offers and responses for the
`Sec-WebSocket-Extensions` header. Zero runtime dependencies, ESM only.

```js
import { selectDeflate, buildOffer, parseExtensions } from './src/index.js';

// Server side: pick an offer from the client's header.
const response = selectDeflate('permessage-deflate; server_max_window_bits=10');
// -> 'permessage-deflate; server_max_window_bits=10'

// Client side: build the offer you want to send.
const offer = buildOffer({ serverNoContextTakeover: true, clientMaxWindowBits: 12 });
// -> 'permessage-deflate; server_no_context_takeover; client_max_window_bits=12'

// Inspect any header value.
const parsed = parseExtensions('permessage-deflate; client_no_context_takeover');
// -> [{ name: 'permessage-deflate', params: { client_no_context_takeover: '' } }]
```

## Why this exists

WebSocket compression negotiation lives entirely in one header, but the header
format is fiddly: quoted-string vs token values, bare flags, integer ranges,
and the question of what a server is allowed to ignore. This library handles
that one header correctly so callers do not have to.

The trade-off: this is **not** a generic `Sec-WebSocket-Extensions` parser. It
understands the four parameters defined by RFC 7692 and nothing else.

## Selection policy (stated plainly)

`selectDeflate` considers only the **first** `permessage-deflate` offer in the
header. If that offer contains any parameter the library does not recognize, the
extension is **rejected** (returns `null`) rather than silently dropping the
unknown parameter. This is stricter than the RFC minimum but prevents a client
from believing a parameter was honored when it was not.

## Edge cases you will hit

- `server_max_window_bits` and `client_max_window_bits` must be integers in
  `[9, 15]`. Values outside that range cause rejection.
- `client_max_window_bits` may appear as a bare flag (no `=` value) — this is a
  client hint. The server echoes it back bare.
- Duplicate parameter names within a single offer throw during parsing.
- Trailing commas in the header are tolerated (ignored), not rejected.

## Exports

- `parseExtension(segment)` — parse one comma-free segment.
- `parseExtensions(header)` — parse a full header into a list.
- `serializeExtension(ext)` — serialize one extension back to wire form.
- `serializeExtensions(list)` — serialize a list into a comma-joined header.
- `selectDeflate(header)` — server-side: returns the response string or `null`.
- `buildOffer(opts)` — client-side: builds a validated offer string.
