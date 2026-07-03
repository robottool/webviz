/**
 * Drives a loaded URDF robot's joints so its tool tip (TCP) follows an
 * interactive gizmo — the "IK" joint source of `RobotModelPlugin`. It owns the
 * drag gizmo and the actuated chain, and supports two interchangeable solver
 * backends:
 *
 *   native   — solve in-browser with the damped-least-squares Jacobian step in
 *              `core/ik.ts`. Fully client-side (no hub), instant, but uses our
 *              generic solver / joint limits.
 *   external — publish the gizmo pose as a `wv/Pose` target to the hub and drive
 *              the robot from a `wv/JointState` solution channel the user's own
 *              solver (MoveIt/KDL/ikfast/…) publishes back. Needs a hub; uses
 *              their exact kinematics, at the cost of a round-trip.
 *
 * Either way the gizmo *is* the target and the robot's base is left frozen (the
 * plugin holds it), so target and FK share the fixed frame. Kinematics come free
 * from `urdf-loader`: the chain is the scene-graph parents root→TCP, FK is
 * `matrixWorld`, and the Jacobian is each joint's world axis + origin.
 */

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader';
import type { JointState, PoseStamped } from '@webviz/protocol';
import type { SceneManager } from '../core/SceneManager.js';
import type { HubClient } from '../protocol/HubClient.js';
import { PoseGizmo } from '../core/poseGizmo.js';
import { sourcePublisher, type PublishHandle } from '../core/sourcePublisher.js';
import { IK_DEFAULTS, orientationError, solveDampedLeastSquares } from '../core/ik.js';

type JointType = 'revolute' | 'continuous' | 'prismatic';

export type IkBackend = 'native' | 'external';

export interface IkConfig {
  backend: IkBackend;
  /** External: channel the gizmo target is published on (wv/Pose). */
  targetChannel: string;
  /** External: channel the solved joints are read from (wv/JointState). */
  solutionChannel: string;
  /** Native: orientation task weight (0–1); position weight is fixed at 1. */
  wRot: number;
}

interface ChainJoint {
  name: string;
  axis: THREE.Vector3; // local joint axis
  type: JointType;
  lower: number;
  upper: number;
  obj: THREE.Object3D; // the URDFJoint (for its world transform)
}

export interface IkResidual {
  pos: number; // metres
  rot: number; // radians
}

const PUBLISH_HZ = 30; // cap while dragging (external)
const KEEPALIVE_MS = 500; // re-publish the target so a late solver latches it

export class RobotIkController {
  /** Orientation task weight (native only, Properties-tunable). */
  wRot: number;

  private container = new THREE.Group();
  private gizmo: PoseGizmo;
  private gizmoId: string;
  private chain: ChainJoint[] = [];
  private tcp: THREE.Object3D | null = null;
  private q: number[] = [];
  private residual: IkResidual = { pos: 0, rot: 0 };

  // External backend
  private readonly backend: IkBackend;
  private readonly targetChannel: string;
  private readonly solutionChannel: string;
  private targetHandle: PublishHandle | null = null;
  private jointHandle: PublishHandle | null = null;
  private unsubSolution: (() => void) | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lastPubMs = 0;
  private hasSolution = false;
  /** The pose last committed via `sendTarget()` (native "Send to robot"); the
   * keepalive re-asserts *this* snapshot, not the live gizmo, so dragging after
   * a send doesn't move the real robot until the next send. */
  private lastSentPose: PoseStamped | null = null;
  /** Joint config last committed via `sendTarget()`, re-asserted by the keepalive. */
  private lastSentJoints: JointState | null = null;

  // Scratch objects reused across the solve loop to avoid per-iteration allocation.
  private readonly targetP = new THREE.Vector3();
  private readonly targetQ = new THREE.Quaternion();
  private readonly tcpP = new THREE.Vector3();
  private readonly tcpQ = new THREE.Quaternion();

  constructor(
    private robot: URDFRobot,
    tcpLinkName: string,
    private scene: SceneManager,
    private baseId: string,
    private hub: HubClient,
    config: IkConfig,
    private onSolved: () => void,
  ) {
    this.backend = config.backend;
    this.targetChannel = config.targetChannel;
    this.solutionChannel = config.solutionChannel;
    this.wRot = config.wRot;
    this.gizmoId = `${baseId}:ik-gizmo`;
    this.buildChain(tcpLinkName);
    this.container.userData.noFit = true; // gizmo excluded from view auto-fit
    this.scene.addObject(this.gizmoId, this.container);
    this.gizmo = new PoseGizmo(this.scene, this.container);
    this.gizmo.onChange(() => this.onGizmoChange());
    this.gizmo.onDragEnd(() => {
      if (this.backend === 'external') this.publishTarget(true);
    });
    this.reseed();
    if (this.backend === 'external') this.startExternal();
  }

  /** Snap the gizmo back to the robot's current TCP pose and re-seed `q` from
   * the robot's current joint values (so switching in / recentring never jumps). */
  reseed(): void {
    this.q = this.chain.map((c) => {
      const j = this.robot.joints[c.name] as unknown as { jointValue?: number[]; angle?: number };
      return j.jointValue?.[0] ?? j.angle ?? 0;
    });
    if (!this.tcp) return;
    this.robot.updateMatrixWorld(true);
    this.tcp.getWorldPosition(this.gizmo.node.position);
    this.tcp.getWorldQuaternion(this.gizmo.node.quaternion);
    this.residual = { pos: 0, rot: 0 };
    if (this.backend === 'external') this.publishTarget(true);
    this.scene.requestRender();
  }

  /** Current position/orientation error, or null when external and no solution
   * has arrived yet (so the UI can show a "waiting for solver" state). */
  getResidual(): IkResidual | null {
    if (this.backend === 'external' && !this.hasSolution) return null;
    return this.residual;
  }

  dispose(): void {
    if (this.keepalive != null) clearInterval(this.keepalive);
    this.keepalive = null;
    this.unsubSolution?.();
    this.unsubSolution = null;
    this.targetHandle?.close();
    this.targetHandle = null;
    this.jointHandle?.close();
    this.jointHandle = null;
    this.gizmo.dispose();
    this.scene.removeObject(this.gizmoId);
  }

  // --- backends ---

  private onGizmoChange(): void {
    if (this.backend === 'native') this.solve();
    else this.publishTarget();
  }

  /** External: advertise the target channel, subscribe to the solution channel,
   * and keep the target alive so a solver that starts later latches onto it. */
  private startExternal(): void {
    this.targetHandle = sourcePublisher.advertise(this.targetChannel, 'wv/Pose', 'json');
    this.unsubSolution = this.hub.subscribe(this.solutionChannel, (m) => {
      if (m.binary) return;
      this.applyExternalJoints(m.data as JointState);
    });
    this.publishTarget(true);
    this.keepalive = setInterval(() => this.publishTarget(true), KEEPALIVE_MS);
  }

  /** A wv/Pose from the gizmo's current transform, in the fixed frame. */
  private currentTargetPose(): PoseStamped {
    const p = this.gizmo.node.position;
    const q = this.gizmo.node.quaternion;
    return {
      id: this.baseId,
      frame_id: this.scene.getFixedFrame(),
      position: [p.x, p.y, p.z],
      orientation: [q.x, q.y, q.z, q.w],
    };
  }

  /** The actuated chain's current joint values as a wv/JointState (the solve
   * the on-screen preview is showing). */
  private currentJointState(): JointState {
    return { names: this.chain.map((c) => c.name), positions: [...this.q] };
  }

  /** External backend: stream the *live* gizmo pose (rate-capped unless forced). */
  private publishTarget(force = false): void {
    if (!this.targetHandle) return;
    const now = performance.now();
    if (!force && now - this.lastPubMs < 1000 / PUBLISH_HZ) return;
    this.lastPubMs = now;
    this.targetHandle.send(this.currentTargetPose());
  }

  /**
   * One-shot "Send to robot" (native backend): publish the current TCP **pose**
   * (`wv/Pose` on `targetChannel`) *and* the previewed **joint config**
   * (`wv/JointState` on `solutionChannel`) once, then **hold** both — a keepalive
   * re-asserts these exact snapshots so a controller that (re)connects still
   * latches them, and so dragging the preview afterwards doesn't command the
   * robot until the next send. Unlike the external backend, nothing is published
   * while you drag.
   */
  sendTarget(): void {
    if (!this.targetHandle) {
      this.targetHandle = sourcePublisher.advertise(this.targetChannel, 'wv/Pose', 'json');
    }
    if (!this.jointHandle) {
      this.jointHandle = sourcePublisher.advertise(this.solutionChannel, 'wv/JointState', 'json');
    }
    this.lastSentPose = this.currentTargetPose();
    this.lastSentJoints = this.currentJointState();
    this.targetHandle.send(this.lastSentPose);
    this.jointHandle.send(this.lastSentJoints);
    if (this.keepalive == null) {
      this.keepalive = setInterval(() => {
        if (this.lastSentPose) this.targetHandle?.send(this.lastSentPose);
        if (this.lastSentJoints) this.jointHandle?.send(this.lastSentJoints);
      }, KEEPALIVE_MS);
    }
  }

  private applyExternalJoints(js: JointState): void {
    for (let i = 0; i < js.names.length; i++) {
      const v = js.positions[i];
      if (v !== undefined) this.robot.setJointValue(js.names[i], v);
    }
    this.robot.updateMatrixWorld(true);
    this.hasSolution = true;
    this.updateResidual();
    this.scene.requestRender();
    this.onSolved();
  }

  // --- native solver ---

  /** Run the warm-started DLS loop toward the gizmo's current pose and apply it. */
  private solve(): void {
    if (!this.tcp || this.chain.length === 0) return;
    const D = IK_DEFAULTS;
    const N = this.chain.length;
    this.targetP.copy(this.gizmo.node.position);
    this.targetQ.copy(this.gizmo.node.quaternion);

    for (let iter = 0; iter < D.maxIters; iter++) {
      this.applyQ();
      this.tcp.getWorldPosition(this.tcpP);
      this.tcp.getWorldQuaternion(this.tcpQ);
      const posErr = this.targetP.clone().sub(this.tcpP);
      const rotErr = orientationError(this.targetQ, this.tcpQ);
      if (posErr.length() < D.posTol && rotErr.length() < D.rotTol) break;

      const e = [
        posErr.x * D.wPos,
        posErr.y * D.wPos,
        posErr.z * D.wPos,
        rotErr.x * this.wRot,
        rotErr.y * this.wRot,
        rotErr.z * this.wRot,
      ];
      // 6×N geometric Jacobian, rows weighted to match `e`.
      const J: number[][] = [[], [], [], [], [], []];
      for (let c = 0; c < N; c++) {
        const jn = this.chain[c];
        const z = jn.axis.clone().transformDirection(jn.obj.matrixWorld); // world axis (normalized)
        const p = new THREE.Vector3().setFromMatrixPosition(jn.obj.matrixWorld);
        let lin: THREE.Vector3;
        let ang: THREE.Vector3;
        if (jn.type === 'prismatic') {
          lin = z.clone();
          ang = new THREE.Vector3(0, 0, 0);
        } else {
          lin = z.clone().cross(this.tcpP.clone().sub(p));
          ang = z.clone();
        }
        J[0][c] = lin.x * D.wPos;
        J[1][c] = lin.y * D.wPos;
        J[2][c] = lin.z * D.wPos;
        J[3][c] = ang.x * this.wRot;
        J[4][c] = ang.y * this.wRot;
        J[5][c] = ang.z * this.wRot;
      }

      const dq = solveDampedLeastSquares(J, e, D.lambda);
      for (let i = 0; i < N; i++) {
        const d = Math.max(-D.maxStep, Math.min(D.maxStep, dq[i]));
        let v = this.q[i] + d;
        const jn = this.chain[i];
        if (jn.type !== 'continuous') v = Math.max(jn.lower, Math.min(jn.upper, v));
        this.q[i] = v;
      }
    }

    this.applyQ();
    this.updateResidual();
    this.scene.requestRender();
    this.onSolved();
  }

  private applyQ(): void {
    for (let i = 0; i < this.chain.length; i++) {
      this.robot.setJointValue(this.chain[i].name, this.q[i]);
    }
    this.robot.updateMatrixWorld(true);
  }

  /** Residual of the *current* robot pose against the gizmo target. */
  private updateResidual(): void {
    if (!this.tcp) return;
    this.tcp.getWorldPosition(this.tcpP);
    this.tcp.getWorldQuaternion(this.tcpQ);
    this.residual = {
      pos: this.tcpP.distanceTo(this.gizmo.node.position),
      rot: orientationError(this.gizmo.node.quaternion, this.tcpQ).length(),
    };
  }

  // --- chain ---

  /** Walk the scene-graph parent chain from the TCP link up to the robot root,
   * collecting the actuated (non-fixed) joints in between, base→tip. */
  private buildChain(tcpLinkName: string): void {
    this.tcp =
      (this.robot.links[tcpLinkName] as THREE.Object3D | undefined) ??
      (this.robot.frames?.[tcpLinkName] as THREE.Object3D | undefined) ??
      null;
    const joints: ChainJoint[] = [];
    let node: THREE.Object3D | null = this.tcp;
    while (node && node !== (this.robot as unknown as THREE.Object3D)) {
      const j = node as unknown as {
        isURDFJoint?: boolean;
        jointType?: string;
        axis?: THREE.Vector3;
        limit?: { lower: number; upper: number };
      };
      if (j.isURDFJoint && j.jointType && j.jointType !== 'fixed') {
        const type = j.jointType as JointType;
        let lower = j.limit?.lower ?? 0;
        let upper = j.limit?.upper ?? 0;
        // Same limit fallbacks as RobotModelPlugin.computeJointInfo.
        if (type === 'continuous' || (lower === 0 && upper === 0)) {
          if (type === 'prismatic') {
            lower = -1;
            upper = 1;
          } else {
            lower = -Math.PI;
            upper = Math.PI;
          }
        }
        joints.push({
          name: (node as unknown as { name: string }).name,
          axis: (j.axis ?? new THREE.Vector3(0, 0, 1)).clone(),
          type,
          lower,
          upper,
          obj: node,
        });
      }
      node = node.parent;
    }
    joints.reverse(); // base → tip
    this.chain = joints;
  }
}
