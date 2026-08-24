/**
 * Unit coverage for the spirograph orb concept
 * (packages/ui/stories/src/concepts/spirograph.ts) against a deterministic,
 * in-memory WebGPU/TSL host stand-in. The real concept module runs unmodified —
 * the fake only records scene-graph wiring and state mutations, so every
 * assertion below exercises spirograph.ts's own math and lifecycle: tube-bundle
 * construction, the world-unit fit of the Lissajous figures, the single shared
 * opacity uniform behind all five fresnel materials, respond-driven radial
 * spread, energy-coupled bundle rotation, the opacity clamp, and dispose-time
 * resource release.
 */

import { describe, expect, it } from "vitest";
import { concept } from "../../stories/src/concepts/spirograph.ts";
import type {
  OrbFrame,
  OrbUniforms,
  VariantHandle,
} from "../../stories/src/orb-kit.ts";

// The documented outer bound of the voice-orb space: the bundle must stay
// well inside ~1.3 world units or it clips through the glass shell.
const ORB_BOUND = 1.3;

class FakeVector3 {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}
}

class FakeNode {
  constructor(
    readonly label: string,
    readonly inputs: readonly unknown[],
    readonly root: FakeUniform | null,
  ) {}

  private step(label: string, ...inputs: unknown[]): FakeNode {
    const source = this instanceof FakeUniform ? this : this.root;
    return new FakeNode(label, [this, ...inputs], source);
  }

  dot(other: FakeNode): FakeNode {
    return this.step("dot", other);
  }

  abs(): FakeNode {
    return this.step("abs");
  }

  oneMinus(): FakeNode {
    return this.step("oneMinus");
  }

  pow(exp: number): FakeNode {
    return this.step(`pow(${exp})`, exp);
  }

  mul(factor: FakeNode | number): FakeNode {
    return this.step(`mul(${String(factor)})`, factor);
  }

  add(term: FakeNode | number): FakeNode {
    return this.step(`add(${String(term)})`, term);
  }
}

// A TSL uniform() node: carries a live value the frame loop pumps, and every
// node derived from it keeps a reference back here via `root`.
class FakeUniform extends FakeNode {
  value: number;

  constructor(initial: number) {
    super("uniform", [], null);
    this.value = initial;
  }
}

class FakeCurve {
  disposed = false;

  constructor(
    readonly points: FakeVector3[],
    readonly closed: boolean,
  ) {}
}

class FakeTubeGeometry {
  disposed = false;

  constructor(
    readonly curve: FakeCurve,
    readonly tubularSegments: number,
    readonly radius: number,
    readonly radialSegments: number,
    readonly closed: boolean,
  ) {}

  dispose(): void {
    this.disposed = true;
  }
}

class FakeMeshBasicNodeMaterial {
  disposed = false;
  colorNode: unknown = null;
  opacityNode: unknown = null;
  transparent = false;
  depthWrite = true;
  side: unknown = null;
  blending: unknown = null;

  dispose(): void {
    this.disposed = true;
  }
}

class FakeMesh {
  readonly rotation = { x: 0, y: 0, z: 0 };
  readonly position = { x: 0, y: 0, z: 0 };

  constructor(
    readonly geometry: FakeTubeGeometry,
    readonly material: FakeMeshBasicNodeMaterial,
  ) {}
}

class FakeParent {
  readonly children: FakeMesh[] = [];
  readonly rotation = { x: 0, y: 0, z: 0 };

  add(child: FakeMesh): void {
    this.children.push(child);
  }

  remove(child: FakeMesh): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
  }
}

interface RecordedCurve {
  points: FakeVector3[];
  closed: boolean;
}

function makeHost() {
  const curves: RecordedCurve[] = [];
  const geometries: FakeTubeGeometry[] = [];
  const materials: FakeMeshBasicNodeMaterial[] = [];
  const meshes: FakeMesh[] = [];
  const uniforms: FakeUniform[] = [];

  // Scoped classes, not function expressions: spirograph.ts instantiates these
  // with `new`, and biome's arrow-function assist would rewrite bare function
  // expressions back into arrows (which cannot be constructed) on every
  // `biome check --write`.
  class HostVector3 extends FakeVector3 {}

  class HostCatmullRomCurve3 extends FakeCurve {
    constructor(points: FakeVector3[], closed: boolean) {
      super(points, closed);
      curves.push({ points, closed });
    }
  }

  class HostTubeGeometry extends FakeTubeGeometry {
    constructor(
      curve: FakeCurve,
      tubularSegments: number,
      radius: number,
      radialSegments: number,
      closed: boolean,
    ) {
      super(curve, tubularSegments, radius, radialSegments, closed);
      geometries.push(this);
    }
  }

  class HostMeshBasicNodeMaterial extends FakeMeshBasicNodeMaterial {
    constructor() {
      super();
      materials.push(this);
    }
  }

  class HostMesh extends FakeMesh {
    constructor(
      geometry: FakeTubeGeometry,
      material: FakeMeshBasicNodeMaterial,
    ) {
      super(geometry, material);
      meshes.push(this);
    }
  }

  const normalView = new FakeNode("normalView", [], null);
  const positionViewDirection = new FakeNode("positionViewDirection", [], null);

  const tsl = {
    vec3: (...xyz: number[]) => new FakeNode("vec3", xyz, null),
    normalView,
    positionViewDirection,
    uniform: (initial: number) => {
      const u = new FakeUniform(initial);
      uniforms.push(u);
      return u;
    },
  };

  const host = {
    Vector3: HostVector3,
    CatmullRomCurve3: HostCatmullRomCurve3,
    TubeGeometry: HostTubeGeometry,
    MeshBasicNodeMaterial: HostMeshBasicNodeMaterial,
    Mesh: HostMesh,
    DoubleSide: "double-side",
    NormalBlending: "normal-blending",
  };

  return { host, tsl, curves, geometries, materials, meshes, uniforms };
}

const uniforms: OrbUniforms = {
  uTime: null,
  uEnergy: null,
  uLow: null,
  uListen: null,
  uRespond: null,
  uAspect: null,
  uAccent: null,
};

function buildConcept() {
  const parts = makeHost();
  const parent = new FakeParent();
  const handle = concept.build(
    parts.host,
    parts.tsl,
    uniforms,
    parent,
  ) as VariantHandle;
  return { ...parts, parent, handle };
}

function frameAt(handle: VariantHandle, over: Partial<OrbFrame> = {}): void {
  handle.frame({
    time: 0,
    energy: 0,
    low: 0,
    listen: 0,
    respond: 0,
    ...over,
  });
}

function maxAbsComponent(point: FakeVector3): number {
  return Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
}

describe("concept: spirograph — Lissajous tube bundle (fake WebGPU host)", () => {
  it("registers under the gallery contract as a geometric concept", () => {
    expect(concept.id).toBe("spirograph");
    expect(concept.label).toBe("spirograph");
    expect(concept.family).toBe("geometric");
    expect(typeof concept.build).toBe("function");
  });

  it("builds five tubes wired as distinct geometry + material pairs", () => {
    const { parent, curves, geometries, materials, meshes } = buildConcept();

    expect(curves).toHaveLength(5);
    expect(geometries).toHaveLength(5);
    expect(materials).toHaveLength(5);
    expect(meshes).toHaveLength(5);
    expect(parent.children).toEqual(meshes);

    expect(new Set(meshes.map((m) => m.geometry)).size).toBe(5);
    expect(new Set(meshes.map((m) => m.material)).size).toBe(5);

    for (const mesh of meshes) {
      expect(mesh.material.transparent).toBe(true);
      expect(mesh.material.depthWrite).toBe(false);
      expect(mesh.material.side).toBe("double-side");
      expect(mesh.material.blending).toBe("normal-blending");
      expect(mesh.material.colorNode).not.toBeNull();
      expect(mesh.material.opacityNode).not.toBeNull();
    }
  });

  it("sweeps each tube from one closed, endpoint-deduplicated polyline", () => {
    const { curves, geometries } = buildConcept();

    const lengths = curves.map((c) => c.points.length);
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBeGreaterThan(1);

    for (const curve of curves) {
      expect(curve.closed).toBe(true);
      // Closed CatmullRom already wraps — a duplicated endpoint would kink
      // the sweep, so the sampled figure must not carry one.
      const first = curve.points[0];
      const last = curve.points[curve.points.length - 1];
      const duplicated =
        first.x === last.x && first.y === last.y && first.z === last.z;
      expect(duplicated).toBe(false);
    }

    for (const geo of geometries) {
      expect(geo.closed).toBe(true);
      expect(geo.curve).toBeInstanceOf(FakeCurve);
      expect(geo.radius).toBeGreaterThan(0);
    }
  });

  it("keeps every control point inside the orb's world-unit budget", () => {
    const { curves } = buildConcept();

    let widest = 0;
    for (const curve of curves) {
      for (const point of curve.points) {
        widest = Math.max(widest, maxAbsComponent(point));
      }
    }
    // Non-degenerate: the figures genuinely occupy the volume...
    expect(widest).toBeGreaterThan(0.5);
    // ...but never reach the glass shell at ~1.3 world units.
    expect(widest).toBeLessThan(ORB_BOUND);
  });

  it("routes all five fresnel materials through one shared opacity uniform", () => {
    const { materials, uniforms } = buildConcept();

    expect(uniforms).toHaveLength(1);
    const shared = uniforms[0];
    expect(shared.value).toBeCloseTo(0.8, 12);

    for (const mat of materials) {
      const opacityNode = mat.opacityNode as FakeNode;
      expect(opacityNode.root).toBe(shared);
      // White stays white: the colour graph never derives from the pump.
      const colorNode = mat.colorNode as FakeNode;
      expect(colorNode.label).toBe("vec3");
      expect(colorNode.root).toBeNull();
    }
  });

  it("rests at baseline opacity before any audio arrives", () => {
    const { handle, uniforms } = buildConcept();

    frameAt(handle, {});
    expect(uniforms[0].value).toBeCloseTo(0.72, 12);
  });

  it("pumps the shared opacity uniform and clamps it at 0.95", () => {
    const { handle, uniforms } = buildConcept();
    const shared = uniforms[0];

    frameAt(handle, { energy: 1, respond: 0.25 });
    expect(shared.value).toBeCloseTo(0.94, 12);

    // Extreme input saturates: Math.min must hold the ceiling.
    frameAt(handle, { energy: 5, respond: 5 });
    expect(shared.value).toBe(0.95);
  });

  it("spreads tube pivots radially on respond, scaling linearly", () => {
    const { handle, meshes } = buildConcept();

    frameAt(handle, {});
    for (const mesh of meshes) {
      expect(mesh.position.x).toBeCloseTo(0, 12);
      expect(mesh.position.y).toBeCloseTo(0, 12);
      expect(mesh.position.z).toBeCloseTo(0, 12);
    }

    frameAt(handle, { respond: 0.5 });
    const half = meshes.map((m) => ({ ...m.position }));

    frameAt(handle, { respond: 1 });
    meshes.forEach((mesh, i) => {
      const base = half[i];
      expect(base.x).not.toBe(0);
      expect(mesh.position.x).toBeCloseTo(base.x * 2, 12);
      expect(mesh.position.y).toBeCloseTo(base.y * 2, 12);
      expect(mesh.position.z).toBeCloseTo(base.z * 2, 12);
    });

    // Each tube owns its own spread direction.
    const dirs = new Set(
      half.map((p) =>
        [p.x, p.y, p.z]
          .map((v) => v / (Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z)))
          .join(","),
      ),
    );
    expect(dirs.size).toBe(half.length);
  });

  it("advances bundle yaw monotonically while pitch stays bounded", () => {
    const { handle, parent } = buildConcept();

    frameAt(handle, { time: 0 });
    const afterFirst = parent.rotation.y;
    frameAt(handle, { time: 0.5 });
    const afterSecond = parent.rotation.y;

    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBeGreaterThan(afterFirst);

    let peakPitch = 0;
    for (let i = 0; i < 40; i++) {
      frameAt(handle, { time: i * 0.37, energy: 1, respond: 1 });
      peakPitch = Math.max(peakPitch, Math.abs(parent.rotation.x));
    }
    expect(peakPitch).toBeLessThanOrEqual(0.16 + 1e-9);
  });

  it("couples bundle speed to the energy channel", () => {
    const quiet = buildConcept();
    const loud = buildConcept();

    frameAt(quiet.handle, { time: 0 });
    frameAt(quiet.handle, { time: 1 });
    frameAt(loud.handle, { time: 0, energy: 1 });
    frameAt(loud.handle, { time: 1, energy: 1 });

    const quietDelta = quiet.parent.rotation.y;
    const loudDelta = loud.parent.rotation.y;
    expect(loudDelta).toBeGreaterThan(quietDelta);
  });

  it("turns each tube at its own rate", () => {
    const { handle, meshes } = buildConcept();

    for (let i = 0; i < 3; i++) {
      frameAt(handle, { time: i * 0.5 });
    }

    const yaws = meshes.map((m) => m.rotation.y);
    for (let i = 1; i < yaws.length; i++) {
      expect(yaws[i]).toBeGreaterThan(yaws[i - 1]);
    }
    for (const mesh of meshes) {
      expect(mesh.rotation.x).not.toBe(0);
      expect(mesh.rotation.z).not.toBe(0);
    }
  });

  it("releases every geometry and material and empties the group on dispose", () => {
    const { handle, parent, geometries, materials, meshes } = buildConcept();

    expect(parent.children).toHaveLength(5);
    handle.dispose();

    for (const geo of geometries) expect(geo.disposed).toBe(true);
    for (const mat of materials) expect(mat.disposed).toBe(true);
    expect(parent.children).toEqual([]);
    expect(parent.children.includes(meshes[0])).toBe(false);
  });

  it("keeps builds independent — driving one bundle never bleeds into another", () => {
    const a = buildConcept();
    const b = buildConcept();

    for (let i = 0; i < 4; i++) {
      frameAt(a.handle, { time: i, energy: 5, respond: 1 });
    }

    expect(a.uniforms[0].value).toBe(0.95);
    expect(b.uniforms[0].value).toBeCloseTo(0.8, 12);
    for (const mesh of b.meshes) {
      expect(mesh.rotation.y).toBe(0);
      expect(mesh.position.x).toBeCloseTo(0, 12);
    }
    expect(b.parent.children).toEqual(b.meshes);
  });
});
