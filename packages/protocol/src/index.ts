/** WebViz wire protocol — the single contract shared by hub, app, and SDKs. */

export const PROTOCOL_VERSION = '1.0';

export * from './schemas.js';
export * from './messages.js';
export * from './binary.js';
export * from './frame.js';
