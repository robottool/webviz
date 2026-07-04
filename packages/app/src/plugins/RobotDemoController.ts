/**
 * RobotDemoController — owns RobotModel's **demo mode** lifecycle, keeping it out
 * of `RobotModelPlugin` proper (the plugin's real job is rendering a URDF and
 * consuming live channels). Mirrors how `RobotIkController` owns the jog/IK
 * concern.
 *
 * Demo mode fakes a robot's live-state pipeline entirely in-browser (no hub): a
 * `core/demoExecutor.ts` node advertises `demo/joint_states` + `demo/base_frame`
 * locally (the monitor's feedback) and **subscribes to the command channel** the
 * jog "Send to robot" publishes, animating the dummy toward each goal — a
 * client-side stand-in for a real robot controller. This controller watches the
 * global `settings.demoMode` flag and drives that scenario up/down, reaching back
 * into the plugin only through the small `DemoHost` interface.
 */

import type { JointState } from '@webviz/protocol';
import type { HubClient } from '../protocol/HubClient.js';
import { DemoExecutor } from '../core/demoExecutor.js';
import { useSettingsStore } from '../store/settings.store.js';

/** The slice of `RobotModelPlugin` the demo controller needs — passed as an
 * adapter so the plugin keeps its internals private and there's no import cycle. */
export interface DemoHost {
  /** Whether a robot is currently loaded. */
  hasRobot(): boolean;
  /** The shallowest URDF link (the base) — where the demo base transform sits. */
  rootLinkName(): string;
  /** The scene's current fixed frame (the demo base transform's parent). */
  fixedFrame(): string;
  /** The monitor robot's current joints (the animation's start config). */
  monitorJointState(): JointState;
  /** The channel "Send to robot" publishes the joint goal on (the executor
   * listens here). */
  commandChannel(): string;
  /** Point the monitor's live-state at these channels (sets settings + rebinds).
   * Passing an empty joint channel unbinds it. */
  bindLiveState(jointChannel: string, rootFrame: string): void;
  /** Full unload: clear the robot + live-state to an empty display. */
  clearRobot(): void;
  /** Turn jog off (tears down the shadow + gizmo). */
  disableJog(): void;
  /** Notify the plugin/UI + request a redraw after a state change. */
  afterChange(): void;
}

export class RobotDemoController {
  /** The active demo node; null unless demo mode is on *and* a robot is loaded. */
  private demo: DemoExecutor | null = null;
  /** Mirrors the global `demoMode` setting. */
  private enabled: boolean;
  private unsub: () => void;

  constructor(
    private hub: HubClient,
    private host: DemoHost,
  ) {
    this.enabled = useSettingsStore.getState().demoMode;
    this.unsub = useSettingsStore.subscribe((s) => {
      if (s.demoMode !== this.enabled) this.setEnabled(s.demoMode);
    });
  }

  /** Whether demo mode is toggled on (for UI relabels). */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether the demo node is live (a robot is loaded under demo mode). */
  isActive(): boolean {
    return this.demo !== null;
  }

  /** The host calls this after a robot (re)loads: start the demo if newly ready,
   * else refresh the fake channels for the new robot. */
  onRobotLoaded(): void {
    if (this.demo) this.refresh();
    else this.startIfReady();
  }

  dispose(): void {
    this.unsub();
    this.demo?.dispose();
    this.demo = null;
  }

  // --- internals ---

  private setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.startIfReady();
    else this.stop();
  }

  private startIfReady(): void {
    if (this.demo || !this.enabled || !this.host.hasRobot()) return;
    this.demo = new DemoExecutor(this.hub);
    this.refresh();
    this.host.afterChange();
  }

  /** (Re)publish the demo feedback channels for the current robot, point the
   * monitor's live-state at them, and (re)subscribe the executor to the command
   * channel. */
  private refresh(): void {
    if (!this.demo || !this.host.hasRobot()) return;
    const rootLink = this.host.rootLinkName();
    // Subscribe the monitor first; the advertise inside `start` binds the
    // (deferred) subscription and then delivers the initial config.
    this.host.bindLiveState(this.demo.jointsChannel, rootLink);
    this.demo.start(
      rootLink,
      this.host.fixedFrame(),
      this.host.monitorJointState(),
      this.host.commandChannel(),
    );
  }

  /** Demo mode off ⇒ tear the whole scenario down: stop the fake publisher,
   * disable jog, unload the URDF, and clear the live-state binding. */
  private stop(): void {
    if (!this.demo) return;
    this.demo.dispose();
    this.demo = null;
    this.host.disableJog();
    this.host.clearRobot();
    this.host.bindLiveState('', 'base_link');
    this.host.afterChange();
  }
}
