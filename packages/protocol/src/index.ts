/** WebViz wire protocol — the single contract shared by hub, app, and SDKs. */

// 1.1 — added the additive `wv/Log` schema (back-compatible).
export const PROTOCOL_VERSION = '1.1';

export * from './schemas.js';
export * from './messages.js';
export * from './binary.js';
export * from './frame.js';
