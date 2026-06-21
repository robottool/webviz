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

pluginRegistry.register('RobotModel', 'Robot Model', robotModelFactory);
pluginRegistry.register('TFFrames', 'TF', tfFramesFactory);
pluginRegistry.register('Marker', 'Marker', markerFactory);
pluginRegistry.register('PointCloud', 'Point Cloud', pointCloudFactory);

export { pluginRegistry };
