/**
 * WebViz wire-protocol schema types (§4.4 of the design doc).
 *
 * These are the on-the-wire shapes for the `data` payload of each channel,
 * keyed by their schema name (`wv/Transform`, `wv/Marker`, ...). The browser
 * only ever reasons about channel names + these schema types — never about
 * where the data originated.
 */

/** A 3-element `[x, y, z]` vector. */
export type Vec3 = [number, number, number];

/** A quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

/** An RGBA color, each component in `[0, 1]`. */
export type ColorRGBA = [number, number, number, number];

export interface Pose {
  position: Vec3;
  orientation: Quat;
}

/** `wv/Transform` — a single stamped parent→child transform. */
export interface Transform {
  frame_id: string;
  parent_frame_id: string;
  translation: Vec3;
  /** Quaternion `[x, y, z, w]`. */
  rotation: Quat;
}

/** `wv/TransformArray` — batch of transforms in one message. */
export type TransformArray = Transform[];

/** `wv/JointState`. */
export interface JointState {
  names: string[];
  positions: number[];
  velocities?: number[];
  efforts?: number[];
}

/** `wv/RobotModel` — either a URL reference or inline URDF XML. */
export interface RobotModel {
  name: string;
  urdf_url?: string;
  urdf_xml?: string;
  /**
   * Optional SRDF (semantic robot description) companion, as a URL or inline
   * XML. WebViz reads only its `<group_state>`s today, exposing each as a named
   * pose preset in the RobotModel display.
   */
  srdf_url?: string;
  srdf_xml?: string;
  package_map?: Record<string, string>;
}

export type MarkerType =
  | 'cube'
  | 'sphere'
  | 'cylinder'
  | 'arrow'
  | 'line_strip'
  | 'line_list'
  | 'points'
  | 'text'
  | 'mesh'
  | 'triangle_list';

export type MarkerAction =
  | 'add'
  | 'modify'
  | 'delete'
  | 'delete_namespace'
  | 'delete_all';

/** `wv/Marker`. Extra fields are type-specific (see §4.4 table). */
export interface Marker {
  id: string;
  namespace: string;
  action: MarkerAction;
  type: MarkerType;
  frame_id: string;
  pose: Pose;
  scale: Vec3;
  color: ColorRGBA;
  lifetime?: number;

  // type-specific extras
  points?: Vec3[];
  colors?: ColorRGBA[];
  text?: string;
  font_size?: number;
  shaft_length?: number;
  head_length?: number;
  width?: number;
  mesh_url?: string;
  mesh_format?: string;
}

export type PointFieldType =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'float64';

export interface PointField {
  name: string;
  offset: number;
  type: PointFieldType;
}

/** `wv/PointCloud` — JSON form (small clouds; big ones come as binary). */
export interface PointCloud {
  frame_id: string;
  fields: PointField[];
  /** base64-encoded packed point data. */
  data: string;
}

/** `wv/LaserScan`. `ranges` may contain the string `"Inf"`. */
export interface LaserScan {
  frame_id: string;
  angle_min: number;
  angle_max: number;
  angle_increment: number;
  range_min: number;
  range_max: number;
  ranges: Array<number | 'Inf'>;
  intensities?: number[];
}

/** `wv/OccupancyGrid`. */
export interface OccupancyGrid {
  frame_id: string;
  resolution: number;
  width: number;
  height: number;
  origin: Pose;
  /** base64 uint8 — 0=free, 100=occupied, 255=unknown. */
  data: string;
}

/** `wv/Path`. */
export interface Path {
  id: string;
  frame_id: string;
  color: ColorRGBA;
  poses: Pose[];
}

/** `wv/Pose`. */
export interface PoseStamped {
  id: string;
  frame_id: string;
  position: Vec3;
  orientation: Quat;
  covariance?: number[];
}

/** `wv/Image` encoding enum (matches the binary header). */
export enum ImageEncoding {
  JPEG = 0,
  PNG = 1,
  RGB8 = 2,
}

/** Decoded `wv/Image` (binary only on the wire). */
export interface ImageFrame {
  frame_id: string;
  width: number;
  height: number;
  encoding: ImageEncoding;
  /** raw image bytes, directly ingestible via createImageBitmap. */
  data: Uint8Array;
}

/** `wv/Custom` — any user-defined JSON object. */
export type Custom = Record<string, unknown>;

/** `wv/Log` severity levels, in ascending order. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** `wv/Log` — one entry in an event/log stream. */
export interface Log {
  level: LogLevel;
  /** logger / source name, e.g. "tf_manager". */
  name: string;
  message: string;
  /** optional event time (seconds); the Log tab falls back to the frame timestamp. */
  stamp?: number;
}

/** Map from schema name to its decoded payload type. */
export interface SchemaMap {
  'wv/Transform': Transform;
  'wv/TransformArray': TransformArray;
  'wv/JointState': JointState;
  'wv/RobotModel': RobotModel;
  'wv/Marker': Marker;
  'wv/PointCloud': PointCloud;
  'wv/LaserScan': LaserScan;
  'wv/OccupancyGrid': OccupancyGrid;
  'wv/Path': Path;
  'wv/Pose': PoseStamped;
  'wv/Image': ImageFrame;
  'wv/Log': Log;
  'wv/Custom': Custom;
}

export type SchemaName = keyof SchemaMap;

/** Wire encoding of a channel. */
export type Encoding = 'json' | 'binary';
