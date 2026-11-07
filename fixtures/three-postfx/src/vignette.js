// A custom post-processing pass: darkens the corners.
export const VignetteShader = {
  name: "VignetteShader",
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec4 color = texture2D(tDiffuse, vUv);
  float d = distance(vUv, vec2(0.5));
  color.rgb *= 1.0 - smoothstep(0.3, 0.8, d) * uStrength;
  gl_FragColor = color;
}
`,
};
