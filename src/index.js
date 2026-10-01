/**
 * Public entry point for the permessage-deflate negotiation library.
 *
 * Re-exports the parsing, selection, and construction helpers from core.js.
 * Keeping everything in core.js and re-exporting here gives consumers a single
 * import surface while letting tests target the implementation module directly.
 */
export {
  parseExtension,
  parseExtensions,
  serializeExtension,
  serializeExtensions,
  selectDeflate,
  buildOffer,
} from './core.js';
