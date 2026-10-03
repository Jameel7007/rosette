// GLSL for the vertex-shader drop, as plain strings so Node tests and Vite both can import them.
//
// How it fits together (see scene/pieces.js):
//   - Every vertex carries `pieceId`. The vertex shader looks the piece up in a float data
//     texture (4 texels per piece) and poses it for the current `uSim`, exactly like the
//     prototype posed its instanced tiles on the CPU.
//   - The pose is computed once at the top of main() so that both the normal chunk and the
//     position chunk can use it. Everything three.js does afterwards (view position, world
//     position, shadow coordinates, lighting) sees the animated vertex.
//   - The SAME pose code runs in the shadow depth material, so shadows fall with the pieces.

/** Texels per piece in the data texture, and what each holds. Keep in sync with pieces.js. */
export const TEXELS_PER_PIECE = 4;
//   texel 0: t0, pivot x, pivot z, sink yb
//   texel 1: tumble fx, tumble fz, spin, height scale sy
//   texel 2: final tilt rx, final tilt rz, roughness, ripple seed
//   texel 3: linear colour r, g, b, facet gain (gold only, 0 for glaze: see lookVertex)

// ------------------------------------------------------------------ vertex: shared by both materials

export const poseParsVertex = /* glsl */ `
uniform sampler2D uPieceData;   // RGBA32F, NearestFilter: per-piece numbers, read with texelFetch
uniform float uSim;             // the simulation clock (seconds). The only per-frame input.
uniform float uDropTime;        // D: seconds from start to landing
uniform float uDropHeight;      // DROP: how high a piece starts
attribute float pieceId;        // float holds integers exactly up to 2^24

vec4 pieceTexel( int id, int k ) {
	int i = id * ${TEXELS_PER_PIECE} + k;
	int w = textureSize( uPieceData, 0 ).x;
	return texelFetch( uPieceData, ivec2( i % w, i / w ), 0 );
}

// three.js Euler angles in the default 'XYZ' order mean R = Rx · Ry · Rz.
// (GLSL mat3 constructors are column by column.)
mat3 rotX( float a ) { float c = cos( a ), s = sin( a ); return mat3( 1.0, 0.0, 0.0,  0.0, c, s,  0.0, -s, c ); }
mat3 rotY( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c ); }
mat3 rotZ( float a ) { float c = cos( a ), s = sin( a ); return mat3( c, s, 0.0,  -s, c, 0.0,  0.0, 0.0, 1.0 ); }

struct PiecePose {
	bool hidden;    // not started yet: collapse the whole piece to one point (no fragments, no shadow)
	mat3 R;         // current rotation about the pivot
	vec3 pivot;     // rest pivot: the piece's centroid on the bed plane
	vec3 offset;    // where the pivot is now
	float sy;       // per-piece height scale
};

// The prototype's pose, for p = (sim - t0) / D:
//   p < 0.8: falling, q = p/0.8, y = DROP (1 - q^2), tumble f = 1 - q
//   p < 1  : settling, q = (p-0.8)/0.2, y = 0.06 sin(pi q), f = 0
//   else   : landed, y = 0, f = 0
// rotation (rx + fx f, spin f, rz + fz f) about the pivot, height scaled by sy, lifted by yb + y.
PiecePose computePiecePose() {
	int id = int( pieceId + 0.5 );
	vec4 a = pieceTexel( id, 0 );   // t0, cx, cz, yb
	vec4 b = pieceTexel( id, 1 );   // fx, fz, spin, sy
	vec4 c = pieceTexel( id, 2 );   // rx, rz, roughness, seed

	float p = ( uSim - a.x ) / uDropTime;
	float y = 0.0, f = 0.0;
	if ( p < 0.8 ) {
		float q = p / 0.8;
		y = uDropHeight * ( 1.0 - q * q );
		f = 1.0 - q;
	} else if ( p < 1.0 ) {
		float q = ( p - 0.8 ) / 0.2;
		y = 0.06 * sin( PI * q );
	}

	PiecePose pose;
	pose.hidden = p < 0.0;
	pose.R = rotX( c.x + b.x * f ) * rotY( b.z * f ) * rotZ( c.y + b.y * f );
	pose.pivot = vec3( a.y, 0.0, a.z );
	pose.offset = vec3( a.y, a.w + y, a.z );
	pose.sy = b.w;
	return pose;
}

// Rest position (as stored in the buffer) -> animated position.
vec3 posePosition( PiecePose pose, vec3 rest ) {
	if ( pose.hidden ) return pose.pivot;
	vec3 local = ( rest - pose.pivot ) * vec3( 1.0, pose.sy, 1.0 );
	return pose.R * local + pose.offset;
}

// Normals take the inverse transpose of R·S, which is R·S^-1 (R is a pure rotation).
// three.js normalises later, in the fragment shader.
vec3 poseNormal( PiecePose pose, vec3 restNormal ) {
	return pose.R * ( restNormal * vec3( 1.0, 1.0 / pose.sy, 1.0 ) );
}
`;

/** Prepended to main(): compute the pose once, before any chunk needs it. */
export const poseMainStart = /* glsl */ `
	PiecePose piecePose = computePiecePose();
`;

/** Replaces <beginnormal_vertex> (MeshStandardMaterial only). */
export const poseBeginNormal = /* glsl */ `
	vec3 objectNormal = poseNormal( piecePose, normal );
	#ifdef USE_TANGENT
		vec3 objectTangent = vec3( tangent.xyz );
	#endif
`;

/** Replaces <begin_vertex> (both materials). */
export const poseBeginVertex = /* glsl */ `
	vec3 transformed = posePosition( piecePose, position );
	#ifdef USE_ALPHAHASH
		vPosition = vec3( position );
	#endif
`;

// ------------------------------------------------------------------ vertex: glaze look (standard material only)

export const lookParsVertex = /* glsl */ `
varying vec3 vPieceColor;   // linear RGB from the data texture
varying float vPieceRough;  // per-piece roughness
varying vec2 vRippleUV;     // rest-space (x, z) plus a per-piece offset: the ripple sticks to the piece
varying float vTopMask;     // 1 on the top cap, fading to 0 down the bevel
varying vec3 vTanX;         // view-space directions of the piece's own x and z axes,
varying vec3 vTanZ;         //   so the ripple stays glued to the piece while it tumbles
varying vec2 vFacet;        // extra slope of the top face (gold facets), in the piece's x and z
`;

/** Appended after <begin_vertex> in the standard material. */
export const lookVertex = /* glsl */ `
	{
		int lookId = int( pieceId + 0.5 );
		vec4 look = pieceTexel( lookId, 2 );
		vec4 tint = pieceTexel( lookId, 3 );
		vPieceColor = tint.rgb;
		// Gold facet: the top face is SHADED as if the piece leaned tint.a times further along
		// its resting tilt (rx, rz). A tilt of rx about x leans the face toward +z, so its slope
		// is (rz, -rx). Only the normal changes, not the slab (see PIECE_LOOK.FACET_GOLD).
		vFacet = tint.a * vec2( look.y, - look.x );
		vPieceRough = look.z;
		vRippleUV = position.xz + vec2( 71.3, 37.9 ) * look.w;
		vTopMask = smoothstep( 0.9, 0.98, normal.y );
		mat3 toView = mat3( modelViewMatrix );
		vTanX = toView * ( piecePose.R * vec3( 1.0, 0.0, 0.0 ) );
		vTanZ = toView * ( piecePose.R * vec3( 0.0, 0.0, 1.0 ) );
	}
`;

// ------------------------------------------------------------------ fragment: colour, roughness, ripple

export const lookParsFragment = /* glsl */ `
uniform float uRipple;       // ripple slope (radians-ish); 0 turns it off
uniform float uRippleFreq;   // ripple cycles per unit
varying vec3 vPieceColor;
varying float vPieceRough;
varying vec2 vRippleUV;
varying float vTopMask;
varying vec3 vTanX;
varying vec3 vTanZ;
varying vec2 vFacet;

// Integer hash (PCG-style) -> a pseudo-random gradient for each lattice point. Integer maths
// keeps it stable for large coordinates (unlike fract(sin(...))), and taking the gradient
// straight from the hash bits avoids a sin/cos per lattice point.
vec2 rippleGradient( vec2 cell ) {
	uvec2 v = uvec2( ivec2( cell ) + 32768 );
	v = v * 1664525u + 1013904223u;
	v.x += v.y * 1664525u; v.y += v.x * 1664525u;
	v ^= v >> 16u;
	v.x += v.y * 1664525u; v.y += v.x * 1664525u;
	v ^= v >> 16u;
	return vec2( v ) * ( 2.0 / 4294967295.0 ) - 1.0;   // each component in [-1, 1]
}

// Gradient noise with its analytic derivative (after Inigo Quilez): returns (value, d/dx, d/dy).
// Smooth (quintic fade), so the slopes it gives are smooth too: no faceting, no sparkle.
vec3 rippleNoise( vec2 p ) {
	vec2 i = floor( p ), f = p - i;
	vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
	vec2 ga = rippleGradient( i );
	vec2 gb = rippleGradient( i + vec2( 1.0, 0.0 ) );
	vec2 gc = rippleGradient( i + vec2( 0.0, 1.0 ) );
	vec2 gd = rippleGradient( i + vec2( 1.0, 1.0 ) );
	float va = dot( ga, f );
	float vb = dot( gb, f - vec2( 1.0, 0.0 ) );
	float vc = dot( gc, f - vec2( 0.0, 1.0 ) );
	float vd = dot( gd, f - vec2( 1.0, 1.0 ) );
	float k = va - vb - vc + vd;
	return vec3(
		va + u.x * ( vb - va ) + u.y * ( vc - va ) + u.x * u.y * k,
		ga + u.x * ( gb - ga ) + u.y * ( gc - ga ) + u.x * u.y * ( ga - gb - gc + gd ) +
			du * ( u.yx * k + vec2( vb, vc ) - va ) );
}

// Slope of the glaze surface at rest-space point uv: three octaves, each rotated so the
// lattice never lines up, each faded out as one cycle shrinks below ~24 pixels: zoomed out
// the ripple is invisible anyway (it only tilts the normal a few degrees), so it reads as
// smooth glaze instead of noise, and the GPU skips the work. pixelsPerUnit comes from fwidth(),
// which the caller must evaluate outside any branch (derivatives need uniform control flow).
vec2 rippleSlope( vec2 uv, float pixelsPerUnit ) {
	vec2 slope = vec2( 0.0 );
	float freq = uRippleFreq, amp = 1.0;
	mat2 turn = mat2( 0.8, 0.6, -0.6, 0.8 );   // ~37 degrees between octaves
	mat2 basis = mat2( 1.0 );
	for ( int o = 0; o < 3; o ++ ) {
		float keep = smoothstep( 10.0, 24.0, pixelsPerUnit / freq );   // pixels per ripple cycle
		if ( keep <= 0.0 ) break;   // finer octaves are even smaller on screen: skip the work
		vec3 n = rippleNoise( basis * uv * freq + float( o ) * 17.0 );
		// n.yz is the gradient in the rotated lattice; transpose(basis) turns it back to uv axes.
		// Each octave adds less slope (×0.45): broad, gentle undulation with finer ripples on top.
		slope += keep * amp * ( transpose( basis ) * n.yz );
		freq *= 2.03; amp *= 0.45; basis = turn * basis;
	}
	return slope / ( 1.0 + 0.45 + 0.45 * 0.45 );   // normalise by the full octave weights
}
`;

/** Appended after <color_fragment>: the piece's own glaze colour. */
export const lookColorFragment = /* glsl */ `
	diffuseColor.rgb *= vPieceColor;
`;

/** Appended after <roughnessmap_fragment>: the piece's own roughness. */
export const lookRoughnessFragment = /* glsl */ `
	roughnessFactor = vPieceRough;
`;

/**
 * Appended after <normal_fragment_maps>: tilt the view-space normal by the glaze slope (ripple)
 * plus the gold facet slope, on the top cap only. vTanX / vTanZ are the piece's own axes in view
 * space, so this is correct at any tumble angle. Lighting reads `normal` after this point, so
 * direct light and reflections both follow it.
 */
export const lookNormalFragment = /* glsl */ `
	{
		float ripplePixelsPerUnit = 1.0 / max( length( fwidth( vRippleUV ) ), 1e-6 );
		vec2 slope = vFacet * vTopMask;
		float rippleAmount = uRipple * vTopMask;
		if ( rippleAmount > 0.0 ) slope += rippleSlope( vRippleUV, ripplePixelsPerUnit ) * rippleAmount;
		if ( slope != vec2( 0.0 ) ) normal = normalize( normal - slope.x * normalize( vTanX ) - slope.y * normalize( vTanZ ) );
	}
`;
