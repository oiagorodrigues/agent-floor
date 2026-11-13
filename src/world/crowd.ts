import { BatchedMesh, Mesh, type BufferGeometry, type Camera, type Group, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';

export interface CrowdPart {
  pivot: Object3D;
  batch: FollowBatch;
  geometryId: number;
  instanceId: number;
}

/** True when the object and every ancestor are visible and the chain ends in a scene. */
function shown(o: Object3D) {
  let top: Object3D = o;
  for (let p: Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    top = p;
  }
  return (top as Scene).isScene === true;
}

/** A BatchedMesh whose instances copy their pivot's world matrix right before each draw. */
class FollowBatch extends BatchedMesh {
  readonly parts = new Set<CrowdPart>();
  vertexCapacity: number;

  constructor(instances: number, vertices: number, material: Material) {
    super(instances, vertices, vertices * 2, material);
    this.vertexCapacity = vertices;
    // Instances move every frame, so the batch-wide bounds would go stale; each
    // instance is still culled against its own bounds.
    this.frustumCulled = false;
    this.receiveShadow = true;
    this.visible = false;
  }

  follow() {
    for (const p of this.parts) {
      const on = shown(p.pivot);
      this.setVisibleAt(p.instanceId, on);
      if (on) this.setMatrixAt(p.instanceId, p.pivot.matrixWorld);
    }
  }

  // Shadow passes call this too (BatchedMesh.onBeforeShadow forwards here), and
  // both run after the scene's world matrices are updated for the frame.
  override onBeforeRender(renderer: WebGLRenderer, scene: Scene, camera: Camera, geometry: BufferGeometry, material: Material, group: Group) {
    this.follow();
    super.onBeforeRender(renderer, scene, camera, geometry, material, group);
  }

  reserve(vertices: number) {
    if (this.instanceCount >= this.maxInstanceCount) this.setInstanceCount(this.maxInstanceCount * 2);
    if (this.unusedVertexCount >= vertices) return;
    this.optimize();
    if (this.unusedVertexCount >= vertices) return;
    const used = this.vertexCapacity - this.unusedVertexCount;
    this.vertexCapacity = Math.max(this.vertexCapacity * 2, used + vertices);
    this.setGeometrySize(this.vertexCapacity, this.vertexCapacity * 2);
  }
}

/**
 * Dynamic batching for the characters. Their parts move every frame, so they
 * can't be merged like furniture (see kit.ts). Instead every part that uses the
 * baked vertex-colour material becomes one instance in a BatchedMesh, and
 * follows its pivot (an empty Group the animation code still moves). All
 * characters together draw in two calls: shadow casters and the rest.
 */
export class Crowd {
  /** Add both to the scene root: instance matrices are world matrices. */
  readonly casters: FollowBatch;
  readonly others: FollowBatch;
  private readonly source: Material;

  /**
   * @param source the material whose meshes get batched (kit.ts `bakedMat`). The
   * batches draw with a copy, so plain meshes and batches never trade shader
   * programs on one material mid-frame.
   */
  constructor(source: Material, instances = 64, vertices = 64 * 1024) {
    this.source = source;
    const material = source.clone();
    this.casters = new FollowBatch(instances, vertices, material);
    this.casters.castShadow = true;
    this.others = new FollowBatch(instances, vertices, material);
  }

  /**
   * Take the meshes of a built Kit group: those using the source material go into
   * a batch and follow `pivot`; any other mesh is attached to `pivot` as is.
   * Returns the parts so the owner can `remove` them.
   */
  add(pivot: Object3D, built: Group): CrowdPart[] {
    const parts: CrowdPart[] = [];
    for (const child of [...built.children]) {
      if (!(child instanceof Mesh) || child.material !== this.source) continue;
      const batch = child.castShadow ? this.casters : this.others;
      const geometry = child.geometry as BufferGeometry;
      batch.reserve(geometry.attributes.position.count);
      const geometryId = batch.addGeometry(geometry);
      const part: CrowdPart = { pivot, batch, geometryId, instanceId: batch.addInstance(geometryId) };
      batch.parts.add(part);
      batch.visible = true;
      parts.push(part);
      built.remove(child);
      geometry.dispose();
    }
    if (built.children.length) pivot.add(built);
    return parts;
  }

  remove(parts: CrowdPart[]) {
    for (const p of parts) {
      p.batch.deleteGeometry(p.geometryId);
      p.batch.parts.delete(p);
      p.batch.visible = p.batch.parts.size > 0;
    }
  }
}
