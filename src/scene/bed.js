// The mortar bed the tiles are pressed into, its red underdrawing (sinopia), the stone curb
// around it and the floor it sits on.
//
// The bed's colour and relief are painted on 2D canvases: a colour map (noise, soft blotches,
// aggregate grains, then the sinopia lines) and a matching grey bump map so the grains catch
// the light. The sinopia is painted on the colour map itself, so tiles cover it as they land.
import * as THREE from 'three';
import { PANEL } from '../config.js';
import { rawHex } from './renderer.js';

const TAU = Math.PI * 2;
const EXT = PANEL.EXT;  // the bed is EXT × EXT units, centred on the origin

/** Tunables owned by this module. */
export const BED = {
  TEX: 2048,          // bed canvas size in pixels (≈ 18 px per unit)
  FLOOR_TEX: 512,     // outer floor tile texture, repeated
  BUMP_SCALE: 0.05,
  CURB: { thickness: 2.2, height: 1.4 },
  // Top of the slab under the bed. The prototype put it at -0.01, one hundredth of a unit
  // under the bed surface: closer than the depth buffer can tell apart once the camera pulls
  // back (≈0.013 units at the finished view, ≈0.13 at full zoom-out), so the slab's flat top
  // z-fought through the mortar in blocky, flickering patches (on r128 too). Sunk to -0.25 it
  // stays hidden and the bed renders clean. Nothing else about the slab is visible: the curb
  // covers its sides and the floor its bottom.
  UNDER_TOP: -0.25,
  UNDER_BOTTOM: -0.61,
};

/**
 * Draws a sinopia spec onto a 2D canvas context. The spec is in pattern units (x, y), where
 * pattern y is world z, so the zellige build can feed its own construction lines:
 *
 *   {
 *     color: [r, g, b],                                   // 0..255, the red-ochre line colour
 *     circles:   [{ r, width, alpha, centre? }],          // centre defaults to [0, 0]
 *     rects:     [{ min: [x, y], max: [x, y], width, alpha }],
 *     polylines: [{ pts: [[x, y], ...], width, alpha, closed? }
 *                 | { paths: [pts, pts, ...], width, alpha, closed? }],
 *   }
 *
 * `width` is in pattern units. A polyline with `paths` is stroked as one path, so where its
 * own sub-paths cross the alpha does not build up.
 *
 * @param g    CanvasRenderingContext2D
 * @param spec drawing spec (above)
 * @param map  { size, ext }: canvas size in px and the world width it covers
 */
export function drawSinopia(g, spec, { size, ext }) {
  const ppu = size / ext;                      // canvas pixels per pattern unit
  const P = v => (v + ext / 2) * ppu;          // pattern coordinate → canvas pixel
  const [r, gr, b] = spec.color ?? [160, 62, 40];
  const pen = item => {
    g.strokeStyle = `rgba(${r},${gr},${b},${item.alpha})`;
    g.lineWidth = item.width * ppu;
  };

  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';

  for (const c of spec.circles ?? []) {
    const [cx, cy] = c.centre ?? [0, 0];
    pen(c);
    g.beginPath();
    g.arc(P(cx), P(cy), c.r * ppu, 0, TAU);
    g.stroke();
  }

  for (const rc of spec.rects ?? []) {
    pen(rc);
    g.strokeRect(P(rc.min[0]), P(rc.min[1]), (rc.max[0] - rc.min[0]) * ppu, (rc.max[1] - rc.min[1]) * ppu);
  }

  for (const pl of spec.polylines ?? []) {
    pen(pl);
    g.beginPath();
    for (const pts of pl.paths ?? [pl.pts]) {
      pts.forEach(([x, y], i) => (i ? g.lineTo(P(x), P(y)) : g.moveTo(P(x), P(y))));
      if (pl.closed) g.closePath();
    }
    g.stroke();
  }

  g.restore();
}

/**
 * Bed colour + bump canvases. The order of rand() calls is the prototype's, call for call:
 * the legacy build shares one random stream between the bed and the tiles, so any change
 * here would reshuffle every tile's colour.
 */
function mortarTextures(renderer, rand, sinopia) {
  const S = BED.TEX;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const bv = document.createElement('canvas'); bv.width = bv.height = S;
  const bg = bv.getContext('2d');
  g.fillStyle = '#bdb3a3'; g.fillRect(0, 0, S, S);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, S, S);

  // Soft light and dark blotches: uneven trowelling
  for (let i = 0; i < 900; i++) {
    const x = rand() * S, y = rand() * S, rad = 30 + rand() * 160;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, rand() < 0.5 ? 'rgba(92,80,64,0.07)' : 'rgba(255,250,240,0.07)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  // Per-pixel grain, the same noise value written into colour and bump
  const id = g.getImageData(0, 0, S, S), bd = bg.getImageData(0, 0, S, S), d = id.data, bb = bd.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 26;
    d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.9;
    bb[i] = bb[i + 1] = bb[i + 2] = 128 + n * 2.2;
  }
  g.putImageData(id, 0, 0);
  bg.putImageData(bd, 0, 0);

  // Aggregate: dark grains are pits in the bump map, light ones stand proud
  for (let i = 0; i < 26000; i++) {
    const x = rand() * S, y = rand() * S, rr = 0.6 + rand() * 2.6, dark = rand() < 0.55;
    g.fillStyle = dark ? 'rgba(78,68,56,0.35)' : 'rgba(246,240,228,0.45)';
    g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
    bg.fillStyle = dark ? 'rgba(20,20,20,0.6)' : 'rgba(240,240,240,0.5)';
    bg.beginPath(); bg.arc(x, y, rr, 0, TAU); bg.fill();
  }

  // The setter's red underdrawing, on the colour map only
  if (sinopia) drawSinopia(g, sinopia, { size: S, ext: EXT });

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const bump = new THREE.CanvasTexture(bv);  // data, not colour: stays in NoColorSpace
  bump.anisotropy = map.anisotropy;
  return { map, bump };
}

/**
 * r128's bump mapping. r151+ normalises the screen-space position derivatives, which makes
 * the relief strength depend on pixels rather than world units: at the opening close-up the
 * bed's grains would come out ~100× flatter than in the prototype. This is the r128 chunk
 * (unnormalised derivatives), with r186's per-map UV name.
 */
const BUMP_R128 = /* glsl */`
#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = dFdx( surf_pos.xyz );
		vec3 vSigmaY = dFdy( surf_pos.xyz );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif
`;

function useR128Bump(material) {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <bumpmap_pars_fragment>', BUMP_R128);
  };
  material.customProgramCacheKey = () => 'bump-r128';
}

/** The outer floor's texture: plain grey-brown noise, tiled. Draws after the bed (rand order). */
function floorTexture(rand) {
  const S = BED.FLOOR_TEX, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#8f8576'; g.fillRect(0, 0, S, S);
  const id = g.getImageData(0, 0, S, S), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 30;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(90, 90);
  return t;
}

/**
 * Builds the bed, outer floor, curb and under-box and adds them to the scene.
 *
 * @param scene  THREE.Scene
 * @param ctx    { renderer, envMap, rand, sinopia }
 *               rand: random stream, consumed bed first, then floor;
 *               sinopia: a drawSinopia spec (null for a bare bed)
 */
export function createBed(scene, { renderer, envMap, rand, sinopia }) {
  const disposables = [];
  const keep = (...xs) => { disposables.push(...xs); return xs[0]; };

  const mt = mortarTextures(renderer, rand, sinopia);
  const bedMat = keep(new THREE.MeshStandardMaterial({
    map: mt.map, bumpMap: mt.bump, bumpScale: BED.BUMP_SCALE,
    roughness: 0.95, metalness: 0, envMap, envMapIntensity: 0.35,
  }), mt.map, mt.bump);
  useR128Bump(bedMat);
  const bed = new THREE.Mesh(keep(new THREE.PlaneGeometry(EXT, EXT)), bedMat);
  bed.rotation.x = -Math.PI / 2;   // plane x,y → world x,-z: canvas row 0 lands at z = -EXT/2
  bed.receiveShadow = true;
  scene.add(bed);

  const ft = keep(floorTexture(rand));
  const floor = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(900, 900)),
    keep(new THREE.MeshStandardMaterial({ map: ft, roughness: 1, envMap, envMapIntensity: 0.25 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  floor.receiveShadow = true;
  scene.add(floor);

  // Low stone curb around the bed
  const curbMat = keep(new THREE.MeshStandardMaterial({ color: '#6e5a43', roughness: 0.8, envMap, envMapIntensity: 0.4 }));
  const hw = EXT / 2, th = BED.CURB.thickness;
  const curb = [
    [0, -hw - th / 2, EXT + th * 2, th],
    [0, hw + th / 2, EXT + th * 2, th],
    [-hw - th / 2, 0, th, EXT],
    [hw + th / 2, 0, th, EXT],
  ].map(([x, z, w, dd]) => {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, BED.CURB.height, dd)), curbMat);
    m.position.set(x, 0.1, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    return m;
  });

  // Slab under the bed (r128 read this hex number as linear, hence rawHex)
  const underH = BED.UNDER_TOP - BED.UNDER_BOTTOM;
  const under = new THREE.Mesh(
    keep(new THREE.BoxGeometry(EXT, underH, EXT)),
    keep(new THREE.MeshStandardMaterial({ color: rawHex(0x6d6455), envMap })),
  );
  under.position.y = BED.UNDER_BOTTOM + underH / 2;
  scene.add(under);

  return {
    bed, floor, curb, under,
    dispose() {
      [bed, floor, ...curb, under].forEach(m => scene.remove(m));
      disposables.forEach(x => x.dispose());
    },
  };
}
