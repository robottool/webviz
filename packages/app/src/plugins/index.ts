/**
 * Plugin registration. Importing this module wires every built-in display
 * plugin into the shared `pluginRegistry`. The 3D tab imports it for its side
 * effect before reading the catalogue.
 */

import { pluginRegistry } from '../core/plugin.js';
import { robotModelFactory } from './RobotModelPlugin.js';
import { tfFramesFactory } from './TFFramesPlugin.js';
import { markerFactory } from './MarkerPlugin.js';
import { pointCloudFactory } from './PointCloudPlugin.js';
import { laserScanFactory } from './LaserScanPlugin.js';
import { occupancyGridFactory } from './OccupancyGridPlugin.js';
import { pathFactory } from './PathPlugin.js';
import { poseFactory } from './PosePlugin.js';
import { coordinateFrameFactory } from './CoordinateFramePlugin.js';

pluginRegistry.register('RobotModel', 'Robot Model', robotModelFactory);
pluginRegistry.register('TFFrames', 'TF', tfFramesFactory);
pluginRegistry.register('Marker', 'Marker', markerFactory);
pluginRegistry.register('PointCloud', 'Point Cloud', pointCloudFactory);
pluginRegistry.register('LaserScan', 'Laser Scan', laserScanFactory);
pluginRegistry.register('OccupancyGrid', 'Occupancy Grid', occupancyGridFactory);
pluginRegistry.register('Path', 'Path', pathFactory);
pluginRegistry.register('Pose', 'Pose', poseFactory);
pluginRegistry.register('CoordinateFrame', 'Coordinate Frame', coordinateFrameFactory);

export { pluginRegistry };
