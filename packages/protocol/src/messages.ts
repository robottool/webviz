/**
 * WebViz control + data message shapes carried over the WebSocket text channel
 * (§4.2, §4.3, §4.5). Binary data frames are handled in `binary.ts`.
 */

import type { Encoding, SchemaName } from './schemas.js';

/** Channel descriptor as advertised by the hub / sources. */
export interface ChannelInfo {
  id: number;
  name: string;
  schema: SchemaName | string;
  encoding: Encoding;
  /** Optional source id, present when the hub multiplexes >1 source. */
  source_id?: string;
  /** Latched (latest-value) channel: the hub caches the most recent frame and
   * replays it to every new subscriber, so late joiners see one-shot data
   * (static maps, /tf_static, robot models) without a re-publish. */
  latched?: boolean;
}

/** Sent by the hub to a freshly connected client. */
export interface ServerInfo {
  op: 'server_info';
  version: string;
  capabilities: string[];
  channels: ChannelInfo[];
}

/** A source declares a new channel. `id` is assigned by the hub on echo. */
export interface Advertise {
  op: 'advertise';
  channel: {
    name: string;
    schema: SchemaName | string;
    encoding?: Encoding;
    /** Request latest-value caching for this channel (see ChannelInfo.latched). */
    latched?: boolean;
  };
}

export interface Unadvertise {
  op: 'unadvertise';
  channel_name: string;
}

export interface SubscribeRequest {
  op: 'subscribe';
  channels: Array<{ id: number; max_hz?: number }>;
}

export interface UnsubscribeRequest {
  op: 'unsubscribe';
  channels: Array<{ id: number }>;
}

/** JSON data frame (§4.3). */
export interface MessageFrame {
  op: 'message';
  channel_id: number;
  timestamp: number;
  data: unknown;
}

// --- Control messages (§4.5) ---

export interface TimeMsg {
  op: 'time';
  timestamp: number;
}

export interface GetParameter {
  op: 'get_parameter';
  id: string;
  name: string;
}

export interface ParameterValue {
  op: 'parameter_value';
  id: string;
  value: unknown;
}

export interface SetParameter {
  op: 'set_parameter';
  name: string;
  value: unknown;
}

export interface Heartbeat {
  op: 'heartbeat';
  source_id: string;
  healthy: boolean;
}

export interface ErrorMsg {
  op: 'error';
  code: string;
  message: string;
}

/** Any JSON message a client may send to the hub. */
export type ClientMessage =
  | SubscribeRequest
  | UnsubscribeRequest
  | GetParameter
  | SetParameter
  | TimeMsg;

/** Any JSON message a source may send to the hub. */
export type SourceMessage =
  | Advertise
  | Unadvertise
  | MessageFrame
  | Heartbeat
  | TimeMsg
  | ParameterValue;

/** Any JSON message the hub may send out. */
export type ServerMessage =
  | ServerInfo
  | Advertise
  | Unadvertise
  | MessageFrame
  | ParameterValue
  | GetParameter
  | SetParameter
  | Heartbeat
  | TimeMsg
  | ErrorMsg;

/** Discriminated union over all JSON ops, for exhaustive routing. */
export type AnyMessage =
  | ServerInfo
  | Advertise
  | Unadvertise
  | SubscribeRequest
  | UnsubscribeRequest
  | MessageFrame
  | TimeMsg
  | GetParameter
  | ParameterValue
  | SetParameter
  | Heartbeat
  | ErrorMsg;
