import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { gsap } from 'gsap';

// A small, locally rendered product metaphor. No models, tracking or remote textures.
// Render on demand: camera movement, a message animation, resize, or pointer input.
export function createScene(host, reduced) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' }); }
  catch { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 768 ? 1 : 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xf3f4f8, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);
  host.classList.add('scene-ready');
  const world = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, .1, 70);
  const look = new THREE.Vector3(0, .7, 0);
  const rig = new THREE.Group();
  world.add(rig);
  camera.position.set(7.4, 7.4, 10.8);
  world.add(new THREE.HemisphereLight(0xffffff, 0x929bc5, 3));
  const sun = new THREE.DirectionalLight(0xffffff, 4.5);
  sun.position.set(-4, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: .1, far: 25 });
  sun.shadow.normalBias = .025;
  sun.shadow.bias = -.0004;
  sun.shadow.radius = 4;
  world.add(sun);
  const fill = new THREE.DirectionalLight(0xaab6ff, 2);
  fill.position.set(5, 3, -5); world.add(fill);
  const mat = (color, roughness = .55, metalness = .1) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const porcelain = mat(0xfafaff, .44);
  const silver = mat(0xaeb9d0, .32, .58);
  const ink = mat(0x171d36, .3, .2);
  const indigo = mat(0x7f91f3, .38, .2);
  function box(parent, dimensions, position, material, radius = .08) {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(...dimensions, 3, radius), material);
    mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: .09 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -.15; floor.receiveShadow = true; world.add(floor);
  // Three physical islands give the message route a clear spatial structure.
  box(rig, [2.4, .3, 3], [-2.3, 0, 1], porcelain, .18);
  box(rig, [1.35, .5, 1.35], [.05, .1, .5], indigo, .16);
  box(rig, [3.65, .3, 2.85], [2.1, 0, -1.15], porcelain, .18);
  const textures = [];
  function texture(width, height, draw) {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); draw(context, width, height);
    const result = new THREE.CanvasTexture(canvas); result.colorSpace = THREE.SRGBColorSpace;
    result.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
    textures.push(result); return { canvas, context, texture: result };
  }
  function text(ctx, string, x, y, size, color = '#171d36', weight = 500) {
    ctx.font = `${weight} ${size}px Outfit, sans-serif`; ctx.fillStyle = color; ctx.fillText(string, x, y);
  }
  function rect(ctx, x, y, width, height, radius, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
  }
  function surface(parent, width, height, position, asset) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: asset.texture, toneMapped: false }));
    mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  const phoneTexture = texture(480, 880, (ctx, w, h) => {
    ctx.fillStyle = '#edf1f0'; ctx.fillRect(0, 0, w, h);
    rect(ctx, 0, 0, w, 184, 0, '#ffffff');
    text(ctx, '9:41', 38, 57, 22, '#171d36');
    rect(ctx, 170, 26, 140, 33, 18, '#171d36');
    text(ctx, 'Your workspace', 38, 129, 29);
    text(ctx, 'via WhatsApp', 38, 164, 19, '#65706b');
    text(ctx, 'A LITTLE AWAY FROM YOUR DESK', 45, 230, 15, '#66736c');
    rect(ctx, 77, 285, 365, 130, 22, '#d7e7dc');
    text(ctx, 'How’s the checkout', 103, 333, 26); text(ctx, 'fix going?', 103, 371, 26);
    rect(ctx, 31, 448, 386, 190, 22, '#ffffff');
    text(ctx, 'FarFromDesk', 55, 491, 24, '#5267cf');
    text(ctx, 'A fix is ready for review.', 55, 538, 25); text(ctx, 'Want the highlights?', 55, 577, 25);
    rect(ctx, 28, 770, 424, 66, 33, '#ffffff');
    text(ctx, 'Message your agents…', 56, 812, 23, '#78817d');
  });
  const phone = new THREE.Group(); phone.position.set(-2.3, 1.63, 1.05); phone.rotation.set(-.18, .12, -.12); rig.add(phone);
  box(phone, [1.55, 2.94, .19], [0, 0, 0], silver, .16);
  box(phone, [1.46, 2.84, .13], [0, 0, .06], ink, .15);
  surface(phone, 1.34, 2.58, [0, 0, .131], phoneTexture);
  box(phone, [.045, .38, .08], [-.795, .5, 0], silver, .02);
  const screenTexture = texture(900, 560, (ctx, w, h) => drawScreen(ctx, w, h, 'Checkout fix'));
  function drawScreen(ctx, w, h, label) {
    ctx.fillStyle = '#18213a'; ctx.fillRect(0, 0, w, h);
    rect(ctx, 0, 0, w, 70, 0, '#242e49');
    ['#e1a8a9', '#d9c792', '#a7cab2'].forEach((color, i) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(35 + i * 25, 35, 7, 0, 7); ctx.fill(); });
    text(ctx, 'Your workspace', 142, 44, 24, '#e3e7f4');
    text(ctx, label, 54, 140, 36, '#f1f3ff');
    text(ctx, 'Codex + Claude · selected sessions', 54, 184, 24, '#9faecb');
    text(ctx, '> Request received from your master', 54, 259, 25, '#acbaff');
    const widths = [465, 590, 380, 520];
    widths.forEach((width, i) => rect(ctx, 54, 300 + i * 31, width, 10, 5, i === 1 ? '#6d82c4' : '#39496b'));
    rect(ctx, 54, 458, 405, 54, 10, '#2d4152'); text(ctx, 'Ready for your review', 77, 493, 25, '#bddece');
  }
  const laptop = new THREE.Group(); laptop.position.set(2.1, .32, -1.1); laptop.rotation.y = -.15; rig.add(laptop);
  box(laptop, [3.05, .13, 2.05], [0, 0, 0], silver, .08);
  box(laptop, [1.01, .017, .54], [0, .074, .52], mat(0xc1c9db), .05);
  const keys = new THREE.InstancedMesh(new THREE.BoxGeometry(.17, .024, .14), ink, 52);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 52; i++) { matrix.makeTranslation((i % 13 - 6) * .207, .087, -.63 + Math.floor(i / 13) * .21); keys.setMatrixAt(i, matrix); }
  laptop.add(keys);
  const lid = new THREE.Group(); lid.position.set(0, 1.05, -.86); lid.rotation.x = -.13; laptop.add(lid);
  box(lid, [3.08, 1.98, .12], [0, 0, 0], silver, .08);
  box(lid, [2.96, 1.86, .045], [0, 0, .069], ink, .07);
  surface(lid, 2.78, 1.68, [0, 0, .094], screenTexture);
  const ffdTexture = { texture: new THREE.TextureLoader().load('/mark.svg', () => render()) };
  ffdTexture.texture.colorSpace = THREE.SRGBColorSpace;
  textures.push(ffdTexture.texture);
  const hubTop = surface(rig, .97, .97, [.05, .36, .5], ffdTexture); hubTop.rotation.x = -Math.PI / 2;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.25, .25, 1.15), new THREE.Vector3(-1.45, .55, 2.12),
    new THREE.Vector3(.05, .48, .5), new THREE.Vector3(1.25, .45, .72), new THREE.Vector3(2.2, .23, -.2),
  ]);
  const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, .025, 8, false), mat(0x8b9cdc)); rig.add(wire);
  const packet = new THREE.Mesh(new THREE.SphereGeometry(.105, 16, 12), new THREE.MeshStandardMaterial({ color: 0x536cf0, emissive: 0x536cf0, emissiveIntensity: .65 }));
  packet.visible = false; rig.add(packet);
  let frame = 0; let visible = true; let disposed = false; let messageTween;
  const motions = new Set();
  function render() {
    if (disposed || frame || !visible || document.hidden) return;
    frame = requestAnimationFrame(() => { frame = 0; camera.lookAt(look); renderer.render(world, camera); });
  }
  function tween(target, values) {
    motions.forEach(active => { if (!active.isActive()) motions.delete(active); });
    const t = gsap.to(target, { ...values, duration: reduced.matches ? 0 : .9, ease: 'power3.out', overwrite: true, onUpdate: render });
    motions.add(t);
  }
  const views = {
    overview: { position: [7.4, 7.4, 10.8], target: [0, .7, 0] },
    phone: { position: [.2, 4.3, 9.2], target: [-1.2, 1.05, .8] },
    desk: { position: [5.5, 4, 7.4], target: [1.45, .7, -.8] },
  };
  function setView(view) {
    const config = views[view] || views.overview;
    tween(camera.position, { x: config.position[0], y: config.position[1], z: config.position[2] });
    tween(look, { x: config.target[0], y: config.target[1], z: config.target[2] });
    render();
  }
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    camera.aspect = width / height; camera.fov = width < 500 ? 46 : 34; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
  }); resize.observe(host);
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) render();
    else { messageTween?.kill(); packet.visible = false; }
  }); observer.observe(host);
  const abort = new AbortController();
  host.addEventListener('pointermove', event => {
    if (reduced.matches || event.pointerType !== 'mouse') return;
    const bounds = host.getBoundingClientRect();
    tween(rig.rotation, { y: ((event.clientX - bounds.left) / bounds.width - .5) * .18 });
  }, { signal: abort.signal });
  host.addEventListener('pointerleave', () => tween(rig.rotation, { y: 0 }), { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); }, { signal: abort.signal });
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); host.classList.remove('scene-ready');
    const figure = host.closest('.hero-art');
    figure.querySelector('.scene-controls').hidden = true;
    figure.querySelector('[data-send-scene]').hidden = true;
    figure.querySelector('[data-scene-status]').textContent = 'Static illustration · sample content. Try the message demo below.';
  }, { signal: abort.signal });
  render();
  return {
    setView,
    setExample(label) { drawScreen(screenTexture.context, 900, 560, label); screenTexture.texture.needsUpdate = true; render(); },
    send() {
      messageTween?.kill();
      if (reduced.matches || !visible) return;
      const state = { value: 0 }; packet.visible = true;
      messageTween = gsap.to(state, { value: 1, duration: 1.7, ease: 'power1.inOut', onUpdate: () => { packet.position.copy(curve.getPoint(state.value)); render(); }, onComplete: () => { packet.visible = false; render(); } });
    },
    dispose() {
      disposed = true; abort.abort(); resize.disconnect(); observer.disconnect();
      cancelAnimationFrame(frame); messageTween?.kill(); motions.forEach(t => t.kill());
      const materials = new Set();
      world.traverse(node => { node.geometry?.dispose(); if (node.material) materials.add(node.material); });
      materials.forEach(material => material.dispose()); textures.forEach(asset => asset.dispose());
      renderer.dispose(); renderer.domElement.remove();
    },
  };
}
