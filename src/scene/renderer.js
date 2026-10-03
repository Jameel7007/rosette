// Renderer, scene, camera, the procedural reflection environment and the two lights.
//
// The look was tuned in the prototype on three r128. This file carries the r128 → r186
// porting notes (docs/CONTRACTS.md §5) so the same numbers give the same picture:
//   - lights are physically based only now, so intensities are multiplied by π;
//   - colour management is on: hex strings are read as sRGB and converted to linear, while
//     r128 used a bare hex *number* as linear as-is (see `rawHex`);
//   - fog is still mixed in *after* the sRGB conversion, as it was in r128, but r186 now
//     converts the fog colour to sRGB first, so the prototype's fog colour needs one more
//     linearisation to land on the same pixels;
//   - r186 takes the specular share out of the diffuse light, so lights get ×1.05 back;
//   - PCFSoftShadowMap is gone; PCFShadowMap with a wider radius gives the same penumbra.
import * as THREE from 'three';

/** Tunables owned by this module. */
export const RENDER = {
  EXPOSURE: 0.92,
  BACKGROUND: '#5d564c',
  FOG: { near: 170, far: 430 },
  FOV: 32,
  // r186's BRDF is energy-conserving: light reflected by the glaze's specular layer (the
  // Fresnel share, ~4-5 % for a dielectric) is taken out of its diffuse light; r128 did not
  // do that, so the same light read ~1 % darker on screen. Measured against the prototype
  // with scripts/compare-port.mjs: ×1.05 brings the mean signed pixel difference to ~0.
  ENERGY_COMP: 1.05,
  SHADOW: {
    MAP: 2048,
    // shadow.bias, near and far are not set here: anim/light.js fitShadow fits them every
    // frame to the area on screen (the prototype's fixed bias detached shadows from pieces).
    NORMAL_BIAS: 0.03,
    // r128's PCFSoftShadowMap filtered over a 3×3-texel box (std ≈ 0.87 texel). r186's
    // PCFShadowMap takes 5 hardware-filtered taps on a disk of this radius (in texels);
    // 1.6 gives about the same spread, so the shadow edges stay soft.
    RADIUS: 1.6,
  },
};

/**
 * How many pixels to draw. The cost of a frame is mostly per pixel (4× multisampled edges of
 * ten thousand bevelled pieces), so the drawing buffer's size is the lever:
 *   - never more than 2 device pixels per CSS pixel (as before), and
 *   - never more than MAX_PIXELS in all: a 1920×1080 window on a 2× screen asked for 8.3 Mpx
 *     and held only 49-54 fps on an M2 Pro; capped to 5 Mpx (ratio 1.55) it measured ~11 ms.
 * Below that ceiling, main.js's governor (scene/governor.js) steps the ratio down on machines
 * that still cannot keep up.
 */
export const QUALITY = { MAX_RATIO: 2, MAX_PIXELS: 5e6 };

/** The pixel ratio to start from (the ceiling) for a w × h CSS-pixel window on a `dpr` screen. */
export function pixelRatioCeiling(dpr, w, h) {
  const fit = Math.sqrt(QUALITY.MAX_PIXELS / Math.max(1, w * h));
  return Math.min(dpr || 1, QUALITY.MAX_RATIO, Math.max(1, fit));
}

/**
 * A hex number read the way r128 read it: the digits taken directly as linear RGB, with no
 * sRGB decoding. The prototype gave its lights and the under-box hex numbers, so this keeps
 * their exact colour (e.g. the hemisphere's ground colour would otherwise get ~4× darker).
 */
export function rawHex(hex) {
  return new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
}

/**
 * The reflection environment: a sphere shaded dark below and warm-light above, plus three
 * bright "window" panels, blurred into a PMREM (pre-filtered mipmapped radiance map).
 * Without it the gold would read as dark brown: metal shows only what it reflects.
 */
function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const sphere = new THREE.SphereGeometry(40, 32, 16);
  const pos = sphere.attributes.position, cols = [];
  // Colours given as numbers are linear in both r128 and r186, so these carry over unchanged
  const low = new THREE.Color(0.16, 0.13, 0.10), high = new THREE.Color(0.85, 0.80, 0.72), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 40;  // -1 at the bottom of the sphere, +1 at the top
    c.copy(low).lerp(high, Math.min(1, Math.max(0, (y + 0.15) * 1.3)));
    cols.push(c.r, c.g, c.b);
  }
  sphere.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  envScene.add(new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));

  // Window panels: brightness k well above 1, so highlights stay hot after tone mapping
  const panel = (w, h, x, y, z, k) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * 0.94, k * 0.84), side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    envScene.add(m);
  };
  panel(22, 12, -18, 26, 14, 7);
  panel(10, 30, 24, 14, -10, 3);
  panel(30, 6, 0, 34, -20, 2.5);

  const envMap = pmrem.fromScene(envScene, 0.03).texture;

  // The baked texture is all we keep
  pmrem.dispose();
  envScene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return envMap;
}

/**
 * Builds everything the frame needs except the bed and the tiles.
 * Returns null when WebGL is unavailable (the caller shows the fallback message).
 */
export function createRenderer(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(pixelRatioCeiling(window.devicePixelRatio, window.innerWidth, window.innerHeight));
  renderer.outputColorSpace = THREE.SRGBColorSpace;  // the default; stated because the look depends on it
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER.EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  // Background: r186 converts this sRGB hex to linear, then back to sRGB for the clear, so
  // it lands on exactly #5d564c as it did in r128.
  scene.background = new THREE.Color(RENDER.BACKGROUND);
  // Fog: the prototype handed fog the *linear* value of the background, and r128 mixed fog
  // into already-sRGB pixels, so distant floor faded to a darker brown than the background.
  // r186 converts the fog colour linear → sRGB before mixing, so we linearise once more.
  const bgLinear = new THREE.Color(RENDER.BACKGROUND);
  const fogColor = new THREE.Color().setRGB(bgLinear.r, bgLinear.g, bgLinear.b, THREE.SRGBColorSpace);
  scene.fog = new THREE.Fog(fogColor, RENDER.FOG.near, RENDER.FOG.far);

  const camera = new THREE.PerspectiveCamera(RENDER.FOV, 1, 0.1, 1200);

  const envMap = createEnvironment(renderer);
  // Every material in the piece also sets `envMap: envMap` itself: since r163 a material
  // that only inherits scene.environment ignores its own envMapIntensity.
  scene.environment = envMap;

  // Soft sky/ground fill and one warm sun. ×π: r128's legacy lights had π folded in.
  // ×ENERGY_COMP: see RENDER above.
  const hemi = new THREE.HemisphereLight(rawHex(0xfff3e2), rawHex(0x4c4337), 0.45 * Math.PI * RENDER.ENERGY_COMP);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(rawHex(0xfff0d6), 1.9 * Math.PI * RENDER.ENERGY_COMP);
  sun.castShadow = true;
  sun.shadow.mapSize.set(RENDER.SHADOW.MAP, RENDER.SHADOW.MAP);
  sun.shadow.normalBias = RENDER.SHADOW.NORMAL_BIAS;
  sun.shadow.radius = RENDER.SHADOW.RADIUS;
  scene.add(sun, sun.target);

  /** Fits the drawing buffer to the window at pixel ratio `ratio` (default: keep the current one). */
  function resize(ratio = renderer.getPixelRatio()) {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);  // false: CSS (#c, inset 0) sizes the canvas element
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /**
   * Scales the fog distances. The fog range was set for a landscape screen; on a phone the
   * camera stands ~2× further back (anim/camera.js portraitFactor), which put the finished
   * panel entirely inside the fog (a dark screen, in the prototype too). Scaling the fog by
   * the same factor keeps the phone's picture the same as the desktop's.
   */
  function fitFog(scale) {
    scene.fog.near = RENDER.FOG.near * scale;
    scene.fog.far = RENDER.FOG.far * scale;
  }

  const stage = { renderer, scene, camera, envMap, sun, hemi, resize, fitFog };

  // After a lost WebGL context comes back (a phone reclaiming a background tab's GPU memory),
  // three re-uploads every buffer and texture it still has the data for. The reflection
  // environment is different: it was rendered ON the GPU, so its pixels are simply gone, and
  // the gold went black. Bake it again and hand it to every material that used the old one.
  // (three's own restore handler was registered first, in the WebGLRenderer constructor, so
  // the renderer is working again when this runs.)
  canvas.addEventListener('webglcontextrestored', () => {
    const old = stage.envMap, fresh = createEnvironment(renderer);
    scene.environment = fresh;
    scene.traverse(o => {
      for (const m of [].concat(o.material ?? [])) if (m.envMap === old) m.envMap = fresh;
    });
    stage.envMap = fresh;   // what pieces built from now on use
    renderer.shadowMap.needsUpdate = true;   // its depth map was lost too
  });

  return stage;
}
