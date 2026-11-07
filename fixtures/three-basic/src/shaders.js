export const glowVertex = /* glsl */ `
#include <common>
uniform float uTime;
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec3 p = position + normal * 0.05 * sin(uTime * 2.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const glowFragment = /* glsl */ `
#include <common>
uniform vec3 uColor;
uniform float uTime;
varying vec3 vNormal;
void main() {
  float rim = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.0);
  gl_FragColor = vec4(uColor * (0.6 + 0.4 * rim), 0.8);
}
`;
