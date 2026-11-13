import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, BufferAttribute, Group, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from 'three';

// crowd.ts is TypeScript; Node 20 can't load it, newer Node strips the types.
const skip = !process.features.typescript && 'needs a Node with TypeScript type stripping';
const load = async () => (await import('../src/world/crowd.ts')).Crowd;

const baked = new MeshStandardMaterial({ vertexColors: true });

/** A Kit-shaped mesh: non-indexed, with position, normal, uv and colour. */
function piece(material = baked, cast = true, size = 0.2) {
  const g = new BoxGeometry(size, size, size).toNonIndexed();
  g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(0.5), 3));
  const m = new Mesh(g, material);
  m.castShadow = cast;
  return m;
}

function built(...meshes) {
  const g = new Group();
  g.add(...meshes);
  return g;
}

/** Runs the batches' per-draw hook the way the renderer does. */
function draw(crowd) {
  const camera = new PerspectiveCamera();
  for (const b of [crowd.casters, crowd.others]) b.onBeforeRender(null, null, camera, b.geometry, b.material, null);
}

test('add batches baked meshes by shadow casting and leaves other meshes on the pivot', { skip }, async () => {
  const Crowd = await load();
  const crowd = new Crowd(baked);
  const pivot = new Group();
  const other = piece(new MeshStandardMaterial());
  const parts = crowd.add(pivot, built(piece(baked, true), piece(baked, false), other));

  assert.equal(parts.length, 2);
  assert.equal(crowd.casters.instanceCount, 1);
  assert.equal(crowd.others.instanceCount, 1);
  assert.equal(crowd.casters.visible, true);
  assert.equal(other.parent.parent, pivot);
  assert.equal(other.parent.children.length, 1);
});

test('instances follow their pivot and hide with it', { skip }, async () => {
  const Crowd = await load();
  const crowd = new Crowd(baked);
  const scene = new Scene();
  const root = new Group();
  const pivot = new Group();
  root.add(pivot);
  scene.add(root);
  const [part] = crowd.add(pivot, built(piece()));

  root.position.set(4, 0, -2);
  pivot.position.set(0, 1.5, 0);
  pivot.rotation.x = 0.7;
  scene.updateMatrixWorld();
  draw(crowd);
  // Instance matrices live in a Float32 texture.
  assert.deepEqual(crowd.casters.getMatrixAt(part.instanceId, new Matrix4()).elements, pivot.matrixWorld.elements.map(Math.fround));
  assert.equal(crowd.casters.getVisibleAt(part.instanceId), true);

  root.visible = false;
  draw(crowd);
  assert.equal(crowd.casters.getVisibleAt(part.instanceId), false);

  root.visible = true;
  root.removeFromParent();
  draw(crowd);
  assert.equal(crowd.casters.getVisibleAt(part.instanceId), false);
});

test('the batches grow past their first size and reuse space after removals', { skip }, async () => {
  const Crowd = await load();
  const vertices = piece().geometry.attributes.position.count;
  const crowd = new Crowd(baked, 2, vertices * 2);
  const characters = [];
  for (let i = 0; i < 5; i++) characters.push(crowd.add(new Group(), built(piece(), piece())));
  assert.equal(crowd.casters.instanceCount, 10);

  for (const parts of characters.splice(0, 4)) crowd.remove(parts);
  assert.equal(crowd.casters.instanceCount, 2);
  assert.equal(crowd.casters.visible, true);

  for (let i = 0; i < 6; i++) characters.push(crowd.add(new Group(), built(piece(), piece())));
  assert.equal(crowd.casters.instanceCount, 14);

  for (const parts of characters) crowd.remove(parts);
  assert.equal(crowd.casters.instanceCount, 0);
  assert.equal(crowd.casters.visible, false);
});
