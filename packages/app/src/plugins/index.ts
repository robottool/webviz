/**
 * Plugin registration. Importing this module wires every built-in display
 * plugin into the shared `pluginRegistry`. The 3D tab imports it for its side
 * effect before reading the catalogue.
 */

import { pluginRegistry } from '../core/plugin.js';
import { robotModelFactory } from './RobotModelPlugin.js';

pluginRegistry.register('RobotModel', 'Robot Model', robotModelFactory);

export { pluginRegistry };
