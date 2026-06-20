/**
 * Display plugin contract (§10). A plugin is a self-contained unit that
 * subscribes to one or more channels and manages Three.js objects in a 3D tab's
 * scene. Plugin instances are per-tab (§9.4): two 3D tabs have independent
 * instances, but they share the one HubClient and the one TFManager.
 */

import type { HubClient } from '../protocol/HubClient.js';
import type { TFManager } from './TFManager.js';
import type { SceneManager } from './SceneManager.js';

/** Services handed to every plugin at `initialize` time. */
export interface PluginContext {
  /** The shared hub connection (the doc's `ros`). Subscribe / publish here. */
  hub: HubClient;
  /** The shared TF tree for frame lookups. */
  tf: TFManager;
  /** This tab's Three.js scene. */
  scene: SceneManager;
}

/**
 * A minimal JSON-schema-ish descriptor used to auto-generate the Properties
 * form. Only the field kinds the vertical slice needs are modelled.
 */
export type PropField =
  | { kind: 'boolean'; label: string; default: boolean }
  | { kind: 'number'; label: string; default: number; min?: number; max?: number; step?: number }
  | { kind: 'string'; label: string; default: string }
  | { kind: 'enum'; label: string; default: string; options: () => string[] };

export type PropSchema = Record<string, PropField>;

export interface DisplayPlugin {
  readonly id: string;
  readonly type: string;
  name: string;
  enabled: boolean;

  initialize(ctx: PluginContext): Promise<void>;
  destroy(): void;
  /** Called once per animation frame while the tab is active. */
  onRender(dt: number): void;

  /** Drives the auto-generated Properties form. */
  getSchema(): PropSchema;
  getSettings(): Record<string, unknown>;
  updateSettings(patch: Record<string, unknown>): void;
}

/** Factory signature: build a fresh instance for a given instance id. */
export type PluginFactory = (
  id: string,
  initialSettings?: Record<string, unknown>,
) => DisplayPlugin;

/**
 * PluginRegistry (§8). Maps a plugin `type` to its factory. A single shared
 * registry is fine because factories are stateless; the instances they produce
 * are what live per-tab.
 */
export class PluginRegistry {
  private factories = new Map<string, { factory: PluginFactory; label: string }>();

  register(type: string, label: string, factory: PluginFactory): void {
    this.factories.set(type, { factory, label });
  }

  create(
    type: string,
    id: string,
    initialSettings?: Record<string, unknown>,
  ): DisplayPlugin {
    const entry = this.factories.get(type);
    if (!entry) throw new Error(`Unknown display plugin type: ${type}`);
    return entry.factory(id, initialSettings);
  }

  /** `[type, label]` pairs for the "Add display" menu. */
  catalogue(): Array<{ type: string; label: string }> {
    return [...this.factories.entries()].map(([type, e]) => ({
      type,
      label: e.label,
    }));
  }
}

export const pluginRegistry = new PluginRegistry();
