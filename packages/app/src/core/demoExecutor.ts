/**
 * DemoExecutor — the client-side stand-in for a robot controller, used by demo
 * mode. It plays the same role a real robot would in the jog → "Send to robot"
 * loop, so the jog/send code doesn't special-case demo:
 *
 *   - advertises the dummy's **feedback** channels (`demo/joint_states` +
 *     `demo/base_frame`) via `HubClient.advertiseLocal` (in-app, no hub), which
 *     the RobotModel monitor reads;
 *   - **subscribes to the command channel** (`ik_solution_channel`, the joint
 *     goal that "Send to robot" publishes) and, on each *new* goal, interpolates
 *     the feedback from the current config to the goal over a short window —
 *     exactly like a controller executing a commanded motion.
 *
 * The command is published locally in demo mode (RobotModelPlugin injects
 * `advertiseLocal` as the IK controller's publisher), so this all works with no
 * hub (the static deploy). A real robot would instead receive the same topic
 * over the hub and move itself.
 */

import type { JointState } from '@webviz/protocol';
import type { HubClient, LocalPublishHandle } from '../protocol/HubClient.js';

export const DEMO_JOINTS_CHANNEL = 'demo/joint_states';
export const DEMO_BASE_CHANNEL = 'demo/base_frame';

/** Duration of the interpolated "execute" move. */
const EXECUTE_MS = 800;

/** Idle publish period (~30 Hz): a real controller streams feedback continuously,
 * so we re-send the held pose between moves too — otherwise a stationary robot
 * emits nothing and consumers like the Plot tab see a dead channel. */
const HEARTBEAT_MS = 33;

/** Smoothstep ease so the arm accelerates in and decelerates out. */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Whether two joint-position vectors are effectively equal (the held/keepalive
 * command re-asserts the same goal, which we must not re-animate). */
function sameGoal(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  }
  return true;
}

interface Anim {
  names: string[];
  from: number[];
  to: number[];
  start: number;
}

export class DemoExecutor {
  private joints: LocalPublishHandle | null = null;
  private base: LocalPublishHandle | null = null;
  private unsubCmd: (() => void) | null = null;
  private anim: Anim | null = null;
  private raf = 0;
  private heartbeat = 0;
  /** The last joint config we published (the animation's running value). */
  private current: JointState = { names: [], positions: [] };
  /** Positions of the last goal we acted on, to ignore keepalive re-asserts. */
  private lastGoal: number[] | null = null;

  constructor(private hub: HubClient) {}

  get jointsChannel(): string {
    return DEMO_JOINTS_CHANNEL;
  }

  /**
   * Advertise the dummy's feedback channels (idempotent), publish its current
   * state — an identity base transform placing `rootLink` at `parentFrame`, plus
   * the given joint config — and (re)subscribe to `commandChannel` for goals.
   * Call again after a robot (re)load to refresh all three.
   */
  start(rootLink: string, parentFrame: string, initial: JointState, commandChannel: string): void {
    if (!this.joints) this.joints = this.hub.advertiseLocal(DEMO_JOINTS_CHANNEL, 'wv/JointState');
    if (!this.base) this.base = this.hub.advertiseLocal(DEMO_BASE_CHANNEL, 'wv/Transform');
    this.stopAnim();
    this.lastGoal = null;
    this.current = { names: [...initial.names], positions: [...initial.positions] };
    this.base.send({
      frame_id: rootLink,
      parent_frame_id: parentFrame,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    this.joints.send(this.current);
    this.listen(commandChannel);
    // Stream the held pose while idle so the channel stays live between moves.
    // The animation tick sends at rAF rate, so skip the beat while it runs.
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (!this.anim) this.joints?.send(this.current);
      }, HEARTBEAT_MS) as unknown as number;
    }
  }

  private listen(channel: string): void {
    this.unsubCmd?.();
    this.unsubCmd = this.hub.subscribe(channel, (m) => {
      if (m.binary) return;
      this.onGoal(m.data as JointState);
    });
  }

  /** A commanded joint goal arrived: animate the feedback toward it (unless it's
   * a re-assert of the goal we're already executing). Joints absent from the
   * current config start at 0. */
  private onGoal(goal: JointState): void {
    if (this.lastGoal && sameGoal(this.lastGoal, goal.positions)) return;
    this.lastGoal = [...goal.positions];
    const cur = new Map(this.current.names.map((n, i) => [n, this.current.positions[i]]));
    this.anim = {
      names: [...goal.names],
      from: goal.names.map((n) => cur.get(n) ?? 0),
      to: [...goal.positions],
      start: performance.now(),
    };
    this.tick();
  }

  private tick = (): void => {
    if (!this.anim || !this.joints) return;
    const a = this.anim;
    const t = Math.min(1, (performance.now() - a.start) / EXECUTE_MS);
    const e = easeInOut(t);
    const positions = a.from.map((f, i) => f + (a.to[i] - f) * e);
    this.current = { names: a.names, positions };
    this.joints.send(this.current);
    if (t < 1) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.anim = null;
    }
  };

  private stopAnim(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.anim = null;
  }

  /** Tear down: stop listening/animating and unadvertise the feedback channels. */
  dispose(): void {
    this.unsubCmd?.();
    this.unsubCmd = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = 0;
    this.stopAnim();
    this.joints?.close();
    this.joints = null;
    this.base?.close();
    this.base = null;
  }
}
