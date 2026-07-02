/**
 * Drives a loaded URDF robot's joints so its tool tip (TCP) follows an
 * interactive gizmo — the "IK" joint source of `RobotModelPlugin`. Everything is
 * client-side: `urdf-loader` has already parsed the URDF into a `THREE.Object3D`
 * tree, so forward kinematics is just reading `matrixWorld`, and the geometric
 * Jacobian comes from each joint's world axis + origin. The damped-least-squares
 * step itself lives in `core/ik.ts`.
 *
 * On construction it builds the actuated chain root→TCP, drops a `PoseGizmo` at
 * the current TCP pose, and on every gizmo drag runs a warm-started IK loop and
 * applies the solution. The robot's base is left untouched (the plugin freezes
 * it while in IK), so the gizmo target and the FK live in the same fixed frame.
 */

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader';
import type { SceneManager } from '../core/SceneManager.js';
import { PoseGizmo } from '../core/poseGizmo.js';
import { IK_DEFAULTS, orientationError, solveDampedLeastSquares } from '../core/ik.js';

type JointType = 'revolute' | 'continuous' | 'prismatic';

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

export class RobotIkController {
  /** Orientation task weight (Properties-tunable); position weight stays 1. */
  wRot = IK_DEFAULTS.wRot;

  private container = new THREE.Group();
  private gizmo: PoseGizmo;
  private gizmoId: string;
  private chain: ChainJoint[] = [];
  private tcp: THREE.Object3D | null = null;
  private q: number[] = [];
  private residual: IkResidual = { pos: 0, rot: 0 };

  // Scratch objects reused across the solve loop to avoid per-iteration allocation.
  private readonly targetP = new THREE.Vector3();
  private readonly targetQ = new THREE.Quaternion();
  private readonly tcpP = new THREE.Vector3();
  private readonly tcpQ = new THREE.Quaternion();

  constructor(
    private robot: URDFRobot,
    tcpLinkName: string,
    private scene: SceneManager,
    baseId: string,
    private onSolved: () => void,
  ) {
    this.gizmoId = `${baseId}:ik-gizmo`;
    this.buildChain(tcpLinkName);
    this.scene.addObject(this.gizmoId, this.container);
    this.gizmo = new PoseGizmo(this.scene, this.container);
    this.gizmo.onChange(() => this.solve());
    this.reseed();
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
    this.scene.requestRender();
  }

  getResidual(): IkResidual {
    return this.residual;
  }

  dispose(): void {
    this.gizmo.dispose();
    this.scene.removeObject(this.gizmoId);
  }

  // --- internals ---

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
    // Recompute the residual against the final applied pose for the readout.
    this.tcp.getWorldPosition(this.tcpP);
    this.tcp.getWorldQuaternion(this.tcpQ);
    this.residual = {
      pos: this.targetP.clone().sub(this.tcpP).length(),
      rot: orientationError(this.targetQ, this.tcpQ).length(),
    };
    this.scene.requestRender();
    this.onSolved();
  }

  private applyQ(): void {
    for (let i = 0; i < this.chain.length; i++) {
      this.robot.setJointValue(this.chain[i].name, this.q[i]);
    }
    this.robot.updateMatrixWorld(true);
  }
}
