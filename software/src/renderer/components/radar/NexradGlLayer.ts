import L from 'leaflet'
import {
  MOSAIC_REFLECTIVITY_STOPS,
  NEXRAD_POLAR_DETAIL_ZOOM,
  buildPaletteLut,
  nexradLoopPositionByTimes,
  unpackSweepValues,
  type NexradSweepPayload,
  type PaletteStop
} from '@shared/nexrad'
import { buildClutterMask, denoiseSweep, extrasFromSweep } from '../../lib/nexradClutter'
import { ensureBlockageMap, peekBlockageMap, type BeamBlockageMap } from '../../lib/nexradBlockage'
import type { NexradCompositeFrame } from '../../lib/nexradComposite'
import { attachMosaicDrift } from '../../lib/nexradAdvection'
import { filterHcaGrid, hcaToFloat } from '../../lib/nexradHca'

const VERT = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uPolar0A;
uniform sampler2D uPolar0B;
uniform sampler2D uPolar1A;
uniform sampler2D uPolar1B;
uniform sampler2D uPalette;
uniform vec2 uSize;
uniform float uDpr;
uniform vec2 uTopLeft;
uniform float uScale;
uniform vec3 uSite0;
uniform vec3 uSite1;
uniform float uSiteCount;
uniform vec4 uMeta0A;
uniform vec4 uMeta0B;
uniform vec4 uMeta1A;
uniform vec4 uMeta1B;
uniform float uOpacity;
uniform float uMinDbz;
uniform float uMaxDbz;
uniform float uBlend;
uniform float uThresholdBias;
uniform float uCohesion;
uniform sampler2D uBlock0;
uniform sampler2D uBlock1;
uniform float uHasBlock0;
uniform float uHasBlock1;
uniform sampler2D uFlow;
uniform vec4 uFlowBounds;
uniform float uHasFlow;
uniform float uClassMode;
out vec4 outColor;

float mercatorLat(float y) {
  float n = 3.141592653589793 - 2.0 * 3.141592653589793 * y / uScale;
  return degrees(atan(sinh(n)));
}

float validDbz(float dbz) {
  if (uClassMode > 0.5) return (dbz > 0.5 && dbz < 15.0) ? 1.0 : 0.0;
  return (dbz > -20.0 && dbz < 95.0) ? 1.0 : 0.0;
}

float rangeFloor(float rangeKm) {
  float base = 26.0;
  if (rangeKm < 8.0) base = 37.0;
  else if (rangeKm < 25.0) base = mix(37.0, 29.0, (rangeKm - 8.0) / 17.0);
  else if (rangeKm < 55.0) base = mix(29.0, 22.0, (rangeKm - 25.0) / 30.0);
  else if (rangeKm < 140.0) base = 22.0;
  else if (rangeKm < 190.0) base = mix(22.0, 26.0, (rangeKm - 140.0) / 50.0);
  else base = 26.0;
  return clamp(base + uThresholdBias, 10.0, 42.0);
}

float texelPolar(sampler2D tex, float gates, float azBins, float gate, float azRow) {
  float u = (gate + 0.5) / gates;
  float v = fract((azRow + 0.5) / azBins);
  return texture(tex, vec2(u, v)).r;
}

void tallyClass(float s, float w, inout float c3, inout float c4, inout float c5, inout float c6, inout float c7, inout float c8, inout float c9, inout float c10) {
  if (s < 3.5) c3 += w;
  else if (s < 4.5) c4 += w;
  else if (s < 5.5) c5 += w;
  else if (s < 6.5) c6 += w;
  else if (s < 7.5) c7 += w;
  else if (s < 8.5) c8 += w;
  else if (s < 9.5) c9 += w;
  else c10 += w;
}

vec2 pickClass(float c3, float c4, float c5, float c6, float c7, float c8, float c9, float c10, float center, float empty) {
  float cls = -999.0;
  float bestW = 0.0;
  if (c3 > bestW) { bestW = c3; cls = 3.0; }
  if (c4 > bestW) { bestW = c4; cls = 4.0; }
  if (c5 > bestW) { bestW = c5; cls = 5.0; }
  if (c6 > bestW) { bestW = c6; cls = 6.0; }
  if (c7 > bestW) { bestW = c7; cls = 7.0; }
  if (c8 > bestW) { bestW = c8; cls = 8.0; }
  if (c9 > bestW) { bestW = c9; cls = 9.0; }
  if (c10 > bestW) { bestW = c10; cls = 10.0; }
  if (validDbz(center) > 0.5) {
    float keep = mix(0.92, 0.22, uCohesion);
    float cw = 0.0;
    if (center < 3.5) cw = c3;
    else if (center < 4.5) cw = c4;
    else if (center < 5.5) cw = c5;
    else if (center < 6.5) cw = c6;
    else if (center < 7.5) cw = c7;
    else if (center < 8.5) cw = c8;
    else if (center < 9.5) cw = c9;
    else cw = c10;
    if (cw >= bestW * keep) {
      cls = floor(center + 0.5);
      bestW = max(bestW, cw);
    }
  }
  float filled = c3 + c4 + c5 + c6 + c7 + c8 + c9 + c10;
  float coverage = bestW / max(filled + empty * mix(0.2, 1.15, uCohesion), 0.001);
  float minCover = mix(0.02, 0.4, uCohesion * uCohesion);
  if (cls < 0.5 || coverage < minCover) return vec2(-999.0, 0.0);
  return vec2(cls, clamp(coverage, 0.0, 1.0));
}

vec2 sampleHcaPolar(sampler2D tex, vec4 meta, float slantKm, float azDeg) {
  float firstKm = meta.x;
  float gateKm = meta.y;
  float gates = meta.z;
  float azBins = meta.w;
  float gate = (slantKm - firstKm) / max(gateKm, 0.001);
  if (gate < 0.0 || gate > gates - 1.0) return vec2(-999.0, 0.0);
  float azF = azDeg / 360.0 * azBins;
  float center = texelPolar(tex, gates, azBins, floor(gate + 0.5), floor(azF + 0.5));
  if (uCohesion < 0.06) {
    return validDbz(center) > 0.5 ? vec2(center, 1.0) : vec2(-999.0, 0.0);
  }
  float azKm = max(slantKm, 1.0) * 6.28318530718 / max(azBins, 1.0);
  float targetKm = mix(0.22, 1.2, uCohesion);
  float c3 = 0.0;
  float c4 = 0.0;
  float c5 = 0.0;
  float c6 = 0.0;
  float c7 = 0.0;
  float c8 = 0.0;
  float c9 = 0.0;
  float c10 = 0.0;
  float empty = 0.0;
  for (int da = -2; da <= 2; da++) {
    for (int dg = -2; dg <= 2; dg++) {
      float distKm = length(vec2(float(da) * azKm, float(dg) * gateKm));
      if (distKm > targetKm * 2.1) continue;
      float spatial = exp(-(distKm * distKm) / max(targetKm * targetKm * 1.15, 0.06));
      float s = texelPolar(tex, gates, azBins, gate + float(dg), azF + float(da));
      if (validDbz(s) < 0.5) empty += spatial;
      else tallyClass(s, spatial, c3, c4, c5, c6, c7, c8, c9, c10);
    }
  }
  return pickClass(c3, c4, c5, c6, c7, c8, c9, c10, center, empty);
}

float samplePolar(sampler2D tex, vec4 meta, float slantKm, float azDeg) {
  float firstKm = meta.x;
  float gateKm = meta.y;
  float gates = meta.z;
  float azBins = meta.w;
  float gate = (slantKm - firstKm) / max(gateKm, 0.001);
  if (gate < 0.0 || gate > gates - 1.0) return -999.0;
  float azF = azDeg / 360.0 * azBins;
  float azKm = max(slantKm, 1.0) * 6.28318530718 / max(azBins, 1.0);
  float targetKm = mix(0.28, 0.95, uCohesion);
  float sum = 0.0;
  float wsum = 0.0;
  float near = 0.0;
  float center = texelPolar(tex, gates, azBins, gate, azF);
  float centerW = validDbz(center);
  for (int da = -2; da <= 2; da++) {
    for (int dg = -2; dg <= 2; dg++) {
      float dAz = float(da);
      float dG = float(dg);
      float distKm = length(vec2(dAz * azKm, dG * gateKm));
      if (distKm > targetKm * 2.1) continue;
      float s = texelPolar(tex, gates, azBins, gate + dG, azF + dAz);
      if (validDbz(s) < 0.5) continue;
      float spatial = exp(-(distKm * distKm) / max(targetKm * targetKm * 1.15, 0.06));
      near += 1.0;
      sum += s * spatial;
      wsum += spatial;
    }
  }
  if (centerW > 0.5) {
    float keep = mix(0.96, mix(0.62, 0.92, smoothstep(22.0, 44.0, center)), uCohesion);
    return mix(sum / max(wsum, 0.001), center, keep);
  }
  float need = mix(10.0, 3.0, uCohesion);
  if (uCohesion > 0.12 && near >= need && wsum >= mix(1.6, 0.6, uCohesion)) return sum / wsum;
  return -999.0;
}

vec2 lookSite(vec3 site, float lat, float lon) {
  float lat1 = radians(site.y);
  float lon1 = radians(site.x);
  float lat2 = radians(lat);
  float lon2 = radians(lon);
  float dLat = lat2 - lat1;
  float dLon = lon2 - lon1;
  dLon = mod(dLon + 3.141592653589793, 6.283185307179586) - 3.141592653589793;
  float sinDLat = sin(dLat * 0.5);
  float sinDLon = sin(dLon * 0.5);
  float h = clamp(sinDLat * sinDLat + cos(lat1) * cos(lat2) * sinDLon * sinDLon, 0.0, 1.0);
  float rangeKm = 6371.0 * 2.0 * atan(sqrt(h), sqrt(max(1.0 - h, 0.0)));
  float y = sin(dLon) * cos(lat2);
  float x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon);
  float az = mod(degrees(atan(y, x)) + 360.0, 360.0);
  return vec2(rangeKm, az);
}

float slantFromGround(float groundKm, float elevDeg) {
  float Re = 8494.66666667;
  float e = radians(clamp(elevDeg, -1.0, 20.0));
  float g = groundKm / Re;
  float t = tan(g);
  float denom = cos(e) - sin(e) * t;
  if (denom <= 0.02) return groundKm;
  return Re * t / denom;
}

vec2 sampleFlow(float lon, float lat) {
  if (uHasFlow < 0.5) return vec2(0.0);
  float u = (lon - uFlowBounds.x) / max(uFlowBounds.z - uFlowBounds.x, 0.0001);
  float v = (lat - uFlowBounds.y) / max(uFlowBounds.w - uFlowBounds.y, 0.0001);
  if (u < 0.0 || v < 0.0 || u > 1.0 || v > 1.0) return vec2(0.0);
  vec2 flow = texture(uFlow, vec2(u, v)).rg;
  return vec2(clamp(flow.x, -0.22, 0.22), clamp(flow.y, -0.20, 0.20));
}

vec2 siteLook(sampler2D tex, vec4 meta, vec3 site, float lat, float lon) {
  vec2 look = lookSite(site, lat, lon);
  if (look.x > 230.0) return vec2(-999.0, 0.0);
  float slant = slantFromGround(look.x, site.z);
  if (uClassMode > 0.5) {
    vec2 hca = sampleHcaPolar(tex, meta, slant, look.y);
    if (validDbz(hca.x) < 0.5 || hca.y < 0.04) return vec2(-999.0, 0.0);
    return hca;
  }
  float dbz = samplePolar(tex, meta, slant, look.y);
  if (validDbz(dbz) < 0.5 || dbz < rangeFloor(look.x)) return vec2(-999.0, 0.0);
  return vec2(dbz, 1.0);
}

vec2 morphEcho(vec2 a, vec2 b, float t) {
  if (t <= 0.001) return a.y >= 0.02 ? vec2(a.x, 1.0) : vec2(-999.0, 0.0);
  if (t >= 0.999) return b.y >= 0.02 ? vec2(b.x, 1.0) : vec2(-999.0, 0.0);
  if (a.y >= 0.02 && b.y >= 0.02) {
    return vec2(mix(a.x, b.x, t), 1.0);
  }
  if (a.y >= 0.02) return vec2(a.x, 1.0 - t);
  if (b.y >= 0.02) return vec2(b.x, t);
  return vec2(-999.0, 0.0);
}

float sampleBlock(sampler2D tex, float has, float rangeKm, float azDeg) {
  if (has < 0.5) return 0.0;
  float u = clamp((rangeKm / 230.0), 0.0, 0.999);
  float v = fract(azDeg / 360.0);
  return clamp(texture(tex, vec2(u, v)).r, 0.0, 1.0);
}

float beamH(float rangeKm, float elevDeg) {
  float Re = 8494.66666667;
  float e = radians(elevDeg);
  return sqrt(rangeKm * rangeKm + Re * Re + 2.0 * rangeKm * Re * sin(e)) - Re;
}

float radarAccuracy(float rangeKm, float heightKm, float block) {
  float clear = max(0.0, 1.0 - block);
  if (clear < 0.4) return 0.0;
  float rangeQ = 0.06;
  if (rangeKm >= 22.0 && rangeKm <= 115.0) rangeQ = 1.0;
  else if (rangeKm < 8.0) rangeQ = 0.05;
  else if (rangeKm < 22.0) rangeQ = 0.05 + 0.95 * (rangeKm - 8.0) / 14.0;
  else if (rangeKm < 160.0) rangeQ = mix(1.0, 0.45, (rangeKm - 115.0) / 45.0);
  else rangeQ = max(0.06, mix(0.45, 0.06, (rangeKm - 160.0) / 70.0));
  float heightQ = exp(-max(0.0, heightKm - 0.6) / 2.4);
  return rangeQ * heightQ * clear * clear;
}

void main() {
  vec2 layer = uTopLeft + vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) / uDpr;
  float lon = layer.x / uScale * 360.0 - 180.0;
  float lat = mercatorLat(layer.y);
  vec2 look0 = lookSite(uSite0, lat, lon);
  vec2 look1 = lookSite(uSite1, lat, lon);
  vec2 s0 = siteLook(uPolar0A, uMeta0A, uSite0, lat, lon);
  vec2 s1 = uSiteCount > 1.5 ? siteLook(uPolar1A, uMeta1A, uSite1, lat, lon) : vec2(-999.0, 0.0);
  float blk0 = sampleBlock(uBlock0, uHasBlock0, look0.x, look0.y);
  float blk1 = uSiteCount > 1.5 ? sampleBlock(uBlock1, uHasBlock1, look1.x, look1.y) : 1.0;
  if (blk0 >= 0.55) s0.y = 0.0;
  if (blk1 >= 0.55) s1.y = 0.0;
  if (uClassMode < 0.5) {
    if (s0.y >= 0.02 && blk0 > 0.02 && blk0 < 0.5) s0.x += 4.342944819 * log(1.0 / (1.0 - blk0));
    if (s1.y >= 0.02 && blk1 > 0.02 && blk1 < 0.5) s1.x += 4.342944819 * log(1.0 / (1.0 - blk1));
  }
  if (s0.y < 0.02 && s1.y < 0.02) discard;
  if (uClassMode > 0.5) {
    float cls = -999.0;
    float cov = 0.0;
    float q0c = s0.y >= 0.02 ? radarAccuracy(look0.x, beamH(look0.x, uSite0.z), blk0) : 0.0;
    float q1c = s1.y >= 0.02 ? radarAccuracy(look1.x, beamH(look1.x, uSite1.z), blk1) : 0.0;
    if (q0c >= q1c && s0.y >= 0.02) {
      cls = s0.x;
      cov = s0.y;
    } else if (s1.y >= 0.02) {
      cls = s1.x;
      cov = s1.y;
    } else {
      cls = s0.x;
      cov = s0.y;
    }
    float tone = clamp((cls - uMinDbz) / max(uMaxDbz - uMinDbz, 1.0), 0.0, 1.0);
    vec4 color = texture(uPalette, vec2(tone, 0.5));
    if (color.a < 0.02 || cov < 0.04) discard;
    outColor = vec4(color.rgb, color.a * uOpacity * clamp(cov, 0.0, 1.0));
    return;
  }
  float r0 = look0.x;
  float r1 = look1.x;
  float h0 = beamH(r0, uSite0.z);
  float h1 = beamH(r1, uSite1.z);
  float q0 = s0.y >= 0.02 ? radarAccuracy(r0, h0, blk0) : 0.0;
  float q1 = s1.y >= 0.02 ? radarAccuracy(r1, h1, blk1) : 0.0;
  float bestQ = max(q0, q1);
  float rel0 = bestQ > 0.0 ? q0 / bestQ : 0.0;
  float rel1 = bestQ > 0.0 ? q1 / bestQ : 0.0;
  float w0 = rel0 >= 0.28 ? q0 * rel0 * rel0 : 0.0;
  float w1 = rel1 >= 0.28 ? q1 * rel1 * rel1 : 0.0;
  float peak = -999.0;
  if (rel0 >= 0.55) peak = s0.x;
  if (rel1 >= 0.55) peak = max(peak, s1.x);
  float avg = (w0 + w1) > 0.0 ? (w0 * s0.x + w1 * s1.x) / (w0 + w1) : peak;
  float toward = 0.2 + 0.45 * smoothstep(26.0, 40.0, peak) * clamp((peak - avg) / 8.0, 0.0, 1.0);
  float dbz = peak > -20.0 ? mix(avg, peak, toward) : avg;
  float rangeKm = w1 > w0 ? r1 : r0;
  float presence = max(s0.y, s1.y);
  float floorDbz = rangeFloor(rangeKm);
  float edge = smoothstep(floorDbz, floorDbz + 4.0, dbz);
  if (edge < 0.04) discard;
  float t = clamp((dbz - uMinDbz) / max(uMaxDbz - uMinDbz, 1.0), 0.0, 1.0);
  vec4 color = texture(uPalette, vec2(t, 0.5));
  if (color.a < 0.02) discard;
  outColor = vec4(color.rgb, color.a * uOpacity * edge * presence);
}`

const FRAG_GRID = `#version 300 es
precision highp float;
uniform sampler2D uGridA;
uniform sampler2D uGridB;
uniform sampler2D uPalette;
uniform vec2 uSize;
uniform float uDpr;
uniform vec2 uTopLeft;
uniform float uScale;
uniform vec4 uBoundsA;
uniform vec4 uBoundsB;
uniform vec2 uGridSizeA;
uniform vec2 uGridSizeB;
uniform float uOpacity;
uniform float uMinDbz;
uniform float uMaxDbz;
uniform float uBlend;
uniform float uThresholdBias;
uniform float uCohesion;
uniform vec2 uDrift;
uniform float uHasDrift;
uniform sampler2D uFlow;
uniform vec4 uFlowBounds;
uniform float uHasFlow;
uniform float uClassMode;
out vec4 outColor;

float mercatorLat(float y) {
  float n = 3.141592653589793 - 2.0 * 3.141592653589793 * y / uScale;
  return degrees(atan(sinh(n)));
}

float validDbz(float dbz) {
  if (uClassMode > 0.5) return (dbz > 0.5 && dbz < 15.0) ? 1.0 : 0.0;
  return (dbz > -20.0 && dbz < 95.0) ? 1.0 : 0.0;
}

void tallyClass(float s, float w, inout float c3, inout float c4, inout float c5, inout float c6, inout float c7, inout float c8, inout float c9, inout float c10) {
  if (s < 3.5) c3 += w;
  else if (s < 4.5) c4 += w;
  else if (s < 5.5) c5 += w;
  else if (s < 6.5) c6 += w;
  else if (s < 7.5) c7 += w;
  else if (s < 8.5) c8 += w;
  else if (s < 9.5) c9 += w;
  else c10 += w;
}

vec2 pickClass(float c3, float c4, float c5, float c6, float c7, float c8, float c9, float c10, float center, float empty) {
  float cls = -999.0;
  float bestW = 0.0;
  if (c3 > bestW) { bestW = c3; cls = 3.0; }
  if (c4 > bestW) { bestW = c4; cls = 4.0; }
  if (c5 > bestW) { bestW = c5; cls = 5.0; }
  if (c6 > bestW) { bestW = c6; cls = 6.0; }
  if (c7 > bestW) { bestW = c7; cls = 7.0; }
  if (c8 > bestW) { bestW = c8; cls = 8.0; }
  if (c9 > bestW) { bestW = c9; cls = 9.0; }
  if (c10 > bestW) { bestW = c10; cls = 10.0; }
  if (validDbz(center) > 0.5) {
    float keep = mix(0.92, 0.22, uCohesion);
    float cw = 0.0;
    if (center < 3.5) cw = c3;
    else if (center < 4.5) cw = c4;
    else if (center < 5.5) cw = c5;
    else if (center < 6.5) cw = c6;
    else if (center < 7.5) cw = c7;
    else if (center < 8.5) cw = c8;
    else if (center < 9.5) cw = c9;
    else cw = c10;
    if (cw >= bestW * keep) {
      cls = floor(center + 0.5);
      bestW = max(bestW, cw);
    }
  }
  float filled = c3 + c4 + c5 + c6 + c7 + c8 + c9 + c10;
  float coverage = bestW / max(filled + empty * mix(0.2, 1.15, uCohesion), 0.001);
  float minCover = mix(0.02, 0.4, uCohesion * uCohesion);
  if (cls < 0.5 || coverage < minCover) return vec2(-999.0, 0.0);
  return vec2(cls, clamp(coverage, 0.0, 1.0));
}

float texelGrid(sampler2D tex, vec2 size, float col, float row) {
  if (col < 0.0 || row < 0.0 || col > size.x - 1.0 || row > size.y - 1.0) return -999.0;
  float u = (col + 0.5) / size.x;
  float v = (row + 0.5) / size.y;
  return texture(tex, vec2(u, v)).r;
}

vec2 sampleHcaGrid(sampler2D tex, vec4 bounds, vec2 size, float lon, float lat) {
  float fx = (lon - bounds.x) / max(bounds.z - bounds.x, 0.0001) * size.x;
  float fy = (lat - bounds.y) / max(bounds.w - bounds.y, 0.0001) * size.y;
  if (fx < -0.5 || fy < -0.5 || fx > size.x + 0.5 || fy > size.y + 0.5) return vec2(-999.0, 0.0);
  float col = floor(fx);
  float row = floor(fy);
  float center = texelGrid(tex, size, col, row);
  if (uCohesion < 0.06) {
    return validDbz(center) > 0.5 ? vec2(center, 1.0) : vec2(-999.0, 0.0);
  }
  float radius = mix(0.65, 2.4, uCohesion);
  float c3 = 0.0;
  float c4 = 0.0;
  float c5 = 0.0;
  float c6 = 0.0;
  float c7 = 0.0;
  float c8 = 0.0;
  float c9 = 0.0;
  float c10 = 0.0;
  float empty = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float dist = length(vec2(float(i), float(j)));
      if (dist > radius * 1.2) continue;
      float spatial = exp(-(dist * dist) / max(radius * radius * 0.55, 0.08));
      float s = texelGrid(tex, size, col + float(i), row + float(j));
      if (validDbz(s) < 0.5) empty += spatial;
      else tallyClass(s, spatial, c3, c4, c5, c6, c7, c8, c9, c10);
    }
  }
  return pickClass(c3, c4, c5, c6, c7, c8, c9, c10, center, empty);
}

float bilinearValid(sampler2D tex, vec2 size, float fx, float fy) {
  float x = fx - 0.5;
  float y = fy - 0.5;
  float x0 = floor(x);
  float y0 = floor(y);
  float tx = clamp(x - x0, 0.0, 1.0);
  float ty = clamp(y - y0, 0.0, 1.0);
  float s00 = texelGrid(tex, size, x0, y0);
  float s10 = texelGrid(tex, size, x0 + 1.0, y0);
  float s01 = texelGrid(tex, size, x0, y0 + 1.0);
  float s11 = texelGrid(tex, size, x0 + 1.0, y0 + 1.0);
  float w00 = validDbz(s00) * (1.0 - tx) * (1.0 - ty);
  float w10 = validDbz(s10) * tx * (1.0 - ty);
  float w01 = validDbz(s01) * (1.0 - tx) * ty;
  float w11 = validDbz(s11) * tx * ty;
  float w = w00 + w10 + w01 + w11;
  if (w < 0.08) return -999.0;
  return (s00 * w00 + s10 * w10 + s01 * w01 + s11 * w11) / w;
}

float sampleGrid(sampler2D tex, vec4 bounds, vec2 size, float lon, float lat) {
  float fx = (lon - bounds.x) / max(bounds.z - bounds.x, 0.0001) * size.x;
  float fy = (lat - bounds.y) / max(bounds.w - bounds.y, 0.0001) * size.y;
  if (fx < -0.5 || fy < -0.5 || fx > size.x + 0.5 || fy > size.y + 0.5) return -999.0;
  float col = floor(fx);
  float row = floor(fy);
  float raw = texelGrid(tex, size, col, row);
  if (uCohesion < 0.06) {
    return validDbz(raw) > 0.5 ? raw : -999.0;
  }
  float center = bilinearValid(tex, size, fx, fy);
  float radius = mix(0.65, 2.4, uCohesion);
  float sum = 0.0;
  float wsum = 0.0;
  float near = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float dx = float(i);
      float dy = float(j);
      float dist = length(vec2(dx, dy));
      if (dist > radius * 1.2) continue;
      float s = texelGrid(tex, size, col + dx, row + dy);
      if (validDbz(s) < 0.5) continue;
      float spatial = exp(-(dist * dist) / max(radius * radius * 0.55, 0.08));
      near += 1.0;
      sum += s * spatial;
      wsum += spatial;
    }
  }
  if (validDbz(center) > 0.5) {
    float keep = mix(0.94, mix(0.52, 0.86, smoothstep(22.0, 44.0, center)), uCohesion);
    return mix(sum / max(wsum, 0.001), center, keep);
  }
  float need = mix(10.0, 3.0, uCohesion);
  if (uCohesion > 0.12 && near >= need && wsum >= mix(1.6, 0.6, uCohesion)) return sum / wsum;
  return -999.0;
}

float compactEcho(sampler2D tex, vec4 bounds, vec2 size, float lon, float lat, float center) {
  if (validDbz(center) < 0.5) return -999.0;
  if (center >= 48.0) return center;
  float fx = (lon - bounds.x) / max(bounds.z - bounds.x, 0.0001) * size.x;
  float fy = (lat - bounds.y) / max(bounds.w - bounds.y, 0.0001) * size.y;
  float n = 0.0;
  float ns = 0.0;
  float ew = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      if (validDbz(bilinearValid(tex, size, fx + float(i), fy + float(j))) < 0.5) continue;
      n += 1.0;
      if (i == 0) ns += 1.0;
      if (j == 0) ew += 1.0;
    }
  }
  if (center < 46.0 && ((ns >= 1.0 && ew < 0.5) || (ew >= 1.0 && ns < 0.5))) return -999.0;
  if (n < (center < 28.0 ? 3.0 : 2.0)) return -999.0;
  return center;
}

float growNewEcho(sampler2D tex, vec4 bounds, vec2 size, float lon, float lat, float center, float t) {
  if (validDbz(center) < 0.5) return -999.0;
  float fx = (lon - bounds.x) / max(bounds.z - bounds.x, 0.0001) * size.x;
  float fy = (lat - bounds.y) / max(bounds.w - bounds.y, 0.0001) * size.y;
  float n = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      if (validDbz(bilinearValid(tex, size, fx + float(i), fy + float(j))) > 0.5) n += 1.0;
    }
  }
  float core = smoothstep(22.0, 48.0, center);
  float need = mix(mix(6.2, 4.2, core), -0.2, smoothstep(0.1, 0.94, t));
  if (n < need) return -999.0;
  return center;
}

vec2 sampleDrift(float lon, float lat) {
  vec2 fallback = uHasDrift > 0.5 ? uDrift : vec2(0.0);
  if (uHasFlow < 0.5) return fallback;
  float u = (lon - uFlowBounds.x) / max(uFlowBounds.z - uFlowBounds.x, 0.0001);
  float v = (lat - uFlowBounds.y) / max(uFlowBounds.w - uFlowBounds.y, 0.0001);
  if (u < 0.0 || v < 0.0 || u > 1.0 || v > 1.0) return fallback;
  return texture(uFlow, vec2(u, v)).rg * vec2(0.70, 0.60) - vec2(0.35, 0.30);
}

void main() {
  vec2 layer = uTopLeft + vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) / uDpr;
  float lon = layer.x / uScale * 360.0 - 180.0;
  float lat = mercatorLat(layer.y);
  float t = clamp(uBlend, 0.0, 1.0);
  vec2 drift = sampleDrift(lon, lat);
  if (uClassMode > 0.5) {
    vec2 ha = sampleHcaGrid(uGridA, uBoundsA, uGridSizeA, lon - t * drift.x, lat - t * drift.y);
    vec2 hb = sampleHcaGrid(uGridB, uBoundsB, uGridSizeB, lon + (1.0 - t) * drift.x, lat + (1.0 - t) * drift.y);
    float cls = -999.0;
    float cov = 0.0;
    if (ha.y >= 0.04 && hb.y >= 0.04) {
      cls = t < 0.5 ? ha.x : hb.x;
      cov = mix(ha.y, hb.y, t);
    } else if (ha.y >= 0.04) {
      cls = ha.x;
      cov = ha.y * (1.0 - t);
    } else if (hb.y >= 0.04) {
      cls = hb.x;
      cov = hb.y * t;
    } else {
      discard;
    }
    float hcaTone = clamp((cls - uMinDbz) / max(uMaxDbz - uMinDbz, 1.0), 0.0, 1.0);
    vec4 hcaColor = texture(uPalette, vec2(hcaTone, 0.5));
    if (hcaColor.a < 0.02 || cov < 0.04) discard;
    outColor = vec4(hcaColor.rgb, hcaColor.a * uOpacity * clamp(cov, 0.0, 1.0));
    return;
  }
  float a = sampleGrid(uGridA, uBoundsA, uGridSizeA, lon - t * drift.x, lat - t * drift.y);
  float b = sampleGrid(uGridB, uBoundsB, uGridSizeB, lon + (1.0 - t) * drift.x, lat + (1.0 - t) * drift.y);
  float va = validDbz(a);
  float vb = validDbz(b);
  float dbz = -999.0;
  float presence = 0.0;
  if (va > 0.5 && vb > 0.5) {
    if (abs(a - b) > 18.0) {
      dbz = t < 0.5 ? a : b;
      presence = t < 0.5 ? 1.0 - t : t;
    } else {
      dbz = mix(a, b, t);
      presence = 1.0;
    }
  } else if (va > 0.5) {
    dbz = a;
    presence = 1.0 - t;
  } else if (vb > 0.5) {
    dbz = b;
    presence = t;
  }
  if (validDbz(dbz) < 0.5 || presence < 0.04) discard;
  float floorDbz = clamp(20.0 + uThresholdBias, 10.0, 36.0);
  float edge = smoothstep(floorDbz, floorDbz + 6.0, dbz);
  if (edge < 0.04) discard;
  float tone = clamp((dbz - uMinDbz) / max(uMaxDbz - uMinDbz, 1.0), 0.0, 1.0);
  vec4 color = texture(uPalette, vec2(tone, 0.5));
  if (color.a < 0.02) discard;
  outColor = vec4(color.rgb, color.a * uOpacity * edge * presence);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL shader alloc failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'compile failed'
    gl.deleteShader(shader)
    throw new Error(log)
  }
  return shader
}

function makePolarTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('WebGL texture alloc failed')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  return texture
}

function makeBlockTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('WebGL texture alloc failed')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]))
  return texture
}

function blockageBytes(map: BeamBlockageMap): Uint8Array {
  const out = new Uint8Array(map.occult.length)
  for (let i = 0; i < map.occult.length; i += 1) {
    out[i] = Math.round(Math.max(0, Math.min(1, map.occult[i]!)) * 255)
  }
  return out
}

function makeGridTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('WebGL texture alloc failed')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

function linkProgram(gl: WebGL2RenderingContext, fragSource: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSource)
  const program = gl.createProgram()
  if (!program) throw new Error('WebGL program alloc failed')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'aPos')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  }
  return program
}

export const NEXRAD_GL_REV = 9

export class NexradGlLayer extends L.Layer {
  private mapRef: L.Map | null = null
  private canvas: HTMLCanvasElement | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private gridProgram: WebGLProgram | null = null
  private polarTex0A: WebGLTexture | null = null
  private polarTex0B: WebGLTexture | null = null
  private polarTex1A: WebGLTexture | null = null
  private polarTex1B: WebGLTexture | null = null
  private blockTex0: WebGLTexture | null = null
  private blockTex1: WebGLTexture | null = null
  private blockKey0 = ''
  private blockKey1 = ''
  private gridTexA: WebGLTexture | null = null
  private gridTexB: WebGLTexture | null = null
  private flowTex: WebGLTexture | null = null
  private flowKey = ''
  private paletteTex: WebGLTexture | null = null
  private vao: WebGLVertexArrayObject | null = null
  private frames: NexradSweepPayload[] = []
  private siteFrames: NexradSweepPayload[][] = []
  private siteMasks: Array<Float32Array | null> = []
  private composite: NexradCompositeFrame[] = []
  private fromSweep: NexradSweepPayload | null = null
  private toSweep: NexradSweepPayload | null = null
  private fromSweep1: NexradSweepPayload | null = null
  private toSweep1: NexradSweepPayload | null = null
  private fromGrid: NexradCompositeFrame | null = null
  private toGrid: NexradCompositeFrame | null = null
  private clutterMask: Float32Array | null = null
  private fromKey = ''
  private toKey = ''
  private fromKey1 = ''
  private toKey1 = ''
  private fromGridKey = ''
  private toGridKey = ''
  private siteSetKey = ''
  private blend = 0
  private progress = 0
  private opacity = 1
  private thresholdBias = 1
  private cohesion = 0.65
  private preferGrid = false
  private driftEnabled = true
  private classMode = false
  private paletteStops: PaletteStop[] = MOSAIC_REFLECTIVITY_STOPS
  private polarCache = new Map<string, Float32Array>()
  private raf: number | null = null
  private lastDrawAt = 0
  private contextDead = false
  private pairFrom = -1
  private pairTo = -1
  private frameSetKey = ''
  private compositeSetKey = ''
  private u: Record<string, WebGLUniformLocation | null> = {}
  private uGrid: Record<string, WebGLUniformLocation | null> = {}
  private onView: (() => void) | null = null
  onContextDead: (() => void) | null = null

  onAdd(map: L.Map): this {
    this.mapRef = map
    const pane = map.getPane('owNexrad') ?? map.getPanes().overlayPane
    this.canvas = L.DomUtil.create('canvas', 'ow-nexrad-gl', pane)
    this.canvas.style.position = 'absolute'
    this.canvas.style.pointerEvents = 'none'
    const gl = this.createGl(this.canvas)
    if (!gl) return this
    this.gl = gl
    this.bindContextHandlers(this.canvas)
    this.initGl(gl)
    this.onView = () => this.scheduleDraw()
    map.on('move zoom resize viewreset moveend zoomend', this.onView)
    this.syncPair()
    this.scheduleDraw()
    return this
  }

  onRemove(map: L.Map): this {
    if (this.onView) map.off('move zoom resize viewreset moveend zoomend', this.onView)
    if (this.raf != null) cancelAnimationFrame(this.raf)
    this.canvas?.remove()
    this.canvas = null
    this.gl = null
    this.program = null
    this.gridProgram = null
    this.mapRef = null
    return this
  }

  setCompositeFrames(frames: NexradCompositeFrame[]): void {
    const key = frames.map((frame) => frame.key).join('|')
    this.composite = frames
    if (key !== this.compositeSetKey) {
      this.compositeSetKey = key
      this.fromGridKey = ''
      this.toGridKey = ''
      this.flowKey = ''
    }
    this.syncPair()
    this.scheduleDraw()
    const needsDrift =
      this.driftEnabled &&
      frames.length >= 2 &&
      frames.slice(0, -1).some((frame) => frame.drift?.flow == null)
    if (needsDrift) {
      void attachMosaicDrift(frames).then((next) => {
        if (this.compositeSetKey !== key) return
        this.composite = next
        this.syncPair()
        this.scheduleDraw()
      })
    }
  }

  setFrames(frames: NexradSweepPayload[]): void {
    const key = frames.map((frame) => frame.meta.key).join('|')
    this.frames = frames
    if (key !== this.frameSetKey) {
      this.frameSetKey = key
      this.clutterMask = frames.every((frame) => frame.meta.qc) ? null : buildClutterMask(frames)
      this.fromKey = ''
      this.toKey = ''
    }
    this.syncPair()
    this.scheduleDraw()
  }

  setSiteLayers(layers: NexradSweepPayload[][]): void {
    const key = layers
      .map((frames) => frames.map((frame) => frame.meta.key).join(','))
      .join('|')
    this.siteFrames = layers
    if (key !== this.siteSetKey) {
      this.siteSetKey = key
      this.siteMasks = layers.map((frames) =>
        frames.every((frame) => frame.meta.qc) ? null : buildClutterMask(frames)
      )
      this.polarCache.clear()
      this.fromKey = ''
      this.toKey = ''
      this.fromKey1 = ''
      this.toKey1 = ''
    }
    this.syncPair()
    this.scheduleDraw()
  }

  setProgress(progress: number): void {
    const next = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
    if (Math.abs(next - this.progress) < 0.00015) return
    this.progress = next
    const clock =
      this.composite.length > 0
        ? this.composite.map((frame) => frame.timeUnix)
        : (this.siteFrames[0]?.length ? this.siteFrames[0] : this.frames).map(
            (frame) => frame.meta.timeUnix
          )
    const pos = nexradLoopPositionByTimes(clock, this.progress)
    const pairChanged = pos.fromIndex !== this.pairFrom || pos.toIndex !== this.pairTo
    const nextBlend = this.canDrift(pos.fromIndex, pos.toIndex) ? pos.blend : 0
    if (!pairChanged && Math.abs(nextBlend - this.blend) < 0.008) return
    this.blend = nextBlend
    if (pairChanged) this.syncPair()
    this.scheduleDraw()
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity
    this.scheduleDraw()
  }

  setThresholdBias(bias: number): void {
    this.thresholdBias = Number.isFinite(bias) ? bias : 0
    this.scheduleDraw()
  }

  setCohesion(cohesion: number): void {
    this.cohesion = Number.isFinite(cohesion) ? Math.min(1, Math.max(0, cohesion)) : 0.65
    this.scheduleDraw()
  }

  setPreferGrid(prefer: boolean): void {
    if (this.preferGrid === prefer) return
    this.preferGrid = prefer
    this.scheduleDraw()
  }

  setDriftEnabled(enabled: boolean): void {
    if (this.driftEnabled === enabled) return
    this.driftEnabled = enabled
    this.syncPair()
    this.scheduleDraw()
  }

  setPalette(stops: PaletteStop[]): void {
    this.paletteStops = stops.length > 0 ? stops : MOSAIC_REFLECTIVITY_STOPS
    this.uploadPalette()
    this.scheduleDraw()
  }

  setClassMode(enabled: boolean): void {
    if (this.classMode === enabled) return
    this.classMode = enabled
    this.fromKey = ''
    this.toKey = ''
    this.fromKey1 = ''
    this.toKey1 = ''
    this.fromGridKey = ''
    this.toGridKey = ''
    this.polarCache.clear()
    this.uploadPalette()
    this.syncPair()
    this.scheduleDraw()
  }

  private uploadPalette(): void {
    if (!this.gl || !this.paletteTex) return
    const lut = buildPaletteLut(this.paletteStops, 256)
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.paletteTex)
    const filter = this.classMode ? this.gl.NEAREST : this.gl.LINEAR
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, filter)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, filter)
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, 256, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, lut)
  }

  private nearestSweep(frames: NexradSweepPayload[], timeUnix: number): NexradSweepPayload | null {
    let best: NexradSweepPayload | null = null
    let bestDt = Infinity
    for (const frame of frames) {
      const dt = Math.abs(frame.meta.timeUnix - timeUnix)
      if (dt < bestDt) {
        best = frame
        bestDt = dt
      }
    }
    return best && bestDt <= 8 * 60 ? best : null
  }

  private canDrift(fromIndex: number, toIndex: number): boolean {
    return this.driftEnabled && fromIndex !== toIndex && this.composite.length >= 2
  }

  private syncPair(): void {
    this.fromGrid = null
    this.toGrid = null
    this.fromSweep = null
    this.toSweep = null
    this.fromSweep1 = null
    this.toSweep1 = null

    const primary = this.siteFrames[0]?.length ? this.siteFrames[0]! : this.frames
    if (primary.length === 0 && this.composite.length === 0) return
    const clock =
      this.composite.length > 0
        ? this.composite.map((frame) => frame.timeUnix)
        : primary.map((frame) => frame.meta.timeUnix)
    const pos = nexradLoopPositionByTimes(clock, this.progress)
    const drifting = this.canDrift(pos.fromIndex, pos.toIndex)
    this.blend = drifting ? pos.blend : 0
    this.pairFrom = pos.fromIndex
    this.pairTo = pos.toIndex

    if (this.composite.length > 0 && this.gridProgram) {
      const from = this.composite[pos.fromIndex] ?? this.composite[0]!
      const to = this.composite[pos.toIndex] ?? from
      this.fromGrid = from
      this.toGrid = drifting ? to : from
      if (this.gl) {
        if (from.key !== this.fromGridKey) {
          this.uploadGrid(this.gl, this.gridTexA, from)
          this.fromGridKey = from.key
        }
        if (to.key !== this.toGridKey) {
          this.uploadGrid(this.gl, this.gridTexB, to)
          this.toGridKey = to.key
        }
        if (from.drift?.flow) this.uploadFlow(this.gl, from)
      }
    }

    if (primary.length === 0) return
    const fromTime = clock[pos.fromIndex] ?? primary[0]!.meta.timeUnix
    const from = this.nearestSweep(primary, fromTime) ?? primary[0]!
    this.fromSweep = from
    this.toSweep = from
    const secondary = this.siteFrames[1] ?? []
    this.fromSweep1 = this.nearestSweep(secondary, fromTime)
    this.toSweep1 = this.fromSweep1
    const useGrid = this.fromGrid != null && this.preferGrid
    if (!this.gl || useGrid) return
    const mask0 = this.siteMasks[0] ?? this.clutterMask
    const mask1 = this.siteMasks[1] ?? null
    if (from.meta.key !== this.fromKey) {
      this.uploadPolar(this.gl, this.polarTex0A, from, mask0)
      this.fromKey = from.meta.key
    }
    if (this.fromSweep1 && this.fromSweep1.meta.key !== this.fromKey1) {
      this.uploadPolar(this.gl, this.polarTex1A, this.fromSweep1, mask1)
      this.fromKey1 = this.fromSweep1.meta.key
    }
  }

  private initGl(gl: WebGL2RenderingContext): void {
    const program = linkProgram(gl, FRAG)
    this.program = program
    try {
      this.gridProgram = linkProgram(gl, FRAG_GRID)
    } catch (err) {
      console.error('NEXRAD mosaic shader failed', err)
      this.gridProgram = null
    }
    this.u = {}
    for (const name of [
      'uSize',
      'uDpr',
      'uTopLeft',
      'uScale',
      'uSite0',
      'uSite1',
      'uSiteCount',
      'uMeta0A',
      'uMeta0B',
      'uMeta1A',
      'uMeta1B',
      'uOpacity',
      'uMinDbz',
      'uMaxDbz',
      'uBlend',
      'uThresholdBias',
      'uCohesion',
      'uPolar0A',
      'uPolar0B',
      'uPolar1A',
      'uPolar1B',
      'uPalette',
      'uBlock0',
      'uBlock1',
      'uHasBlock0',
      'uHasBlock1',
      'uFlow',
      'uFlowBounds',
      'uHasFlow',
      'uClassMode'
    ]) {
      this.u[name] = gl.getUniformLocation(program, name)
    }
    this.uGrid = {}
    const gridProgram = this.gridProgram
    if (gridProgram) {
      for (const name of [
        'uSize',
        'uDpr',
        'uTopLeft',
        'uScale',
        'uBoundsA',
        'uBoundsB',
        'uGridSizeA',
        'uGridSizeB',
        'uOpacity',
        'uMinDbz',
        'uMaxDbz',
        'uBlend',
        'uThresholdBias',
        'uCohesion',
        'uGridA',
        'uGridB',
        'uPalette',
        'uDrift',
        'uHasDrift',
        'uFlow',
        'uFlowBounds',
        'uHasFlow',
        'uClassMode'
      ]) {
        this.uGrid[name] = gl.getUniformLocation(gridProgram, name)
      }
    }
    const vao = gl.createVertexArray()
    const buf = gl.createBuffer()
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.vao = vao

    this.paletteTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const lut = buildPaletteLut(this.paletteStops, 256)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut)

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    this.polarTex0A = makePolarTexture(gl)
    this.polarTex0B = makePolarTexture(gl)
    this.polarTex1A = makePolarTexture(gl)
    this.polarTex1B = makePolarTexture(gl)
    this.blockTex0 = makeBlockTexture(gl)
    this.blockTex1 = makeBlockTexture(gl)
    this.gridTexA = makeGridTexture(gl)
    this.gridTexB = makeGridTexture(gl)
    this.flowTex = gl.createTexture()
    if (this.flowTex) {
      gl.bindTexture(gl.TEXTURE_2D, this.flowTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 0, 255]))
    }
  }

  private uploadBlockage(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture | null,
    map: BeamBlockageMap | null,
    keySlot: 'blockKey0' | 'blockKey1'
  ): boolean {
    if (!texture || !map) return false
    const key = `${map.siteId}:${map.elevationDeg.toFixed(2)}`
    if (this[keySlot] === key) return true
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      map.rangeCount,
      map.azimuthCount,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      blockageBytes(map)
    )
    this[keySlot] = key
    return true
  }

  private uploadFlow(gl: WebGL2RenderingContext, frame: NexradCompositeFrame): void {
    const flow = frame.drift?.flow
    if (!this.flowTex || !flow) return
    const key = `${frame.key}:${flow.cols}x${flow.rows}`
    if (this.flowKey === key) return
    const pixels = new Uint8Array(flow.cols * flow.rows * 4)
    for (let i = 0; i < flow.cols * flow.rows; i += 1) {
      const dLon = flow.vectors[i * 2] ?? 0
      const dLat = flow.vectors[i * 2 + 1] ?? 0
      pixels[i * 4] = Math.round(Math.min(1, Math.max(0, (dLon + 0.35) / 0.7)) * 255)
      pixels[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, (dLat + 0.3) / 0.6)) * 255)
      pixels[i * 4 + 2] = 0
      pixels[i * 4 + 3] = 255
    }
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, flow.cols, flow.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    this.flowKey = key
  }

  private uploadGrid(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture | null,
    frame: NexradCompositeFrame
  ): void {
    if (!texture) return
    gl.bindTexture(gl.TEXTURE_2D, texture)
    const field =
      this.classMode && frame.hca && frame.hca.length === frame.values.length
        ? filterHcaGrid(frame.hca)
        : frame.values
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      frame.cols,
      frame.rows,
      0,
      gl.RED,
      gl.FLOAT,
      field
    )
  }

  private denoiseCached(sweep: NexradSweepPayload, mask: Float32Array | null): Float32Array {
    const size = sweep.meta.azimuthCount * sweep.meta.gateCount
    if (this.classMode) return hcaToFloat(sweep.hca, size)
    const key = `${sweep.meta.key}:${mask ? 'm' : 'n'}:${sweep.meta.azimuthCount}x${sweep.meta.gateCount}`
    const hit = this.polarCache.get(key)
    if (hit) return hit
    const values = unpackSweepValues(sweep)
    if (!sweep.meta.qc) {
      denoiseSweep(values, sweep.meta.azimuthCount, sweep.meta.gateCount, mask, extrasFromSweep(sweep))
    }
    if (this.polarCache.size > 36) {
      const first = this.polarCache.keys().next().value
      if (first) this.polarCache.delete(first)
    }
    this.polarCache.set(key, values)
    return values
  }

  private uploadPolar(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture | null,
    sweep: NexradSweepPayload,
    mask: Float32Array | null = this.clutterMask
  ): void {
    if (!texture) return
    const values = this.denoiseCached(sweep, mask)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      sweep.meta.gateCount,
      sweep.meta.azimuthCount,
      0,
      gl.RED,
      gl.FLOAT,
      values
    )
  }

  private glOptions(): WebGLContextAttributes {
    return {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default'
    }
  }

  private createGl(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
    return canvas.getContext('webgl2', this.glOptions())
  }

  private bindContextHandlers(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      'webglcontextlost',
      () => {
        this.gl = null
        this.program = null
        this.gridProgram = null
        if (this.contextDead) return
        this.contextDead = true
        this.onContextDead?.()
      },
      false
    )
  }

  private scheduleDraw(): void {
    if (this.raf != null || this.contextDead) return
    this.raf = requestAnimationFrame(() => {
      this.raf = null
      const now = performance.now()
      if (now - this.lastDrawAt < 42) {
        this.scheduleDraw()
        return
      }
      this.lastDrawAt = now
      this.draw()
    })
  }

  private draw(): void {
    const map = this.mapRef
    const canvas = this.canvas
    const gl = this.gl
    if (!map || !canvas || !gl || this.contextDead || gl.isContextLost()) return
    if (typeof document !== 'undefined' && document.hidden) return

    const size = map.getSize()
    if (size.x < 2 || size.y < 2) return
    const zoom = map.getZoom()
    const longEdge = Math.max(size.x, size.y, 1)
    const cap = zoom >= 9 ? 1024 : zoom >= 8 ? 960 : 832
    const fit = Math.min(1, cap / longEdge)
    const width = Math.max(1, Math.round(size.x * fit))
    const height = Math.max(1, Math.round(size.y * fit))
    const dpr = width / Math.max(size.x, 1)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
    canvas.style.width = `${size.x}px`
    canvas.style.height = `${size.y}px`

    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const scale = map.options.crs?.scale(zoom) ?? 256 * 2 ** zoom
    const topLeftWorld = map.project(map.containerPointToLatLng([0, 0]), zoom)
    const useGrid = this.fromGrid != null && this.gridProgram != null && (
      this.preferGrid ||
      this.driftEnabled ||
      this.fromSweep == null ||
      zoom < NEXRAD_POLAR_DETAIL_ZOOM
    )
    if (useGrid) {
      this.drawGrid(gl, width, height, dpr, topLeftWorld.x, topLeftWorld.y, scale)
      return
    }
    this.drawPolar(gl, width, height, dpr, topLeftWorld.x, topLeftWorld.y, scale)
  }

  private drawGrid(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    dpr: number,
    topLeftX: number,
    topLeftY: number,
    scale: number
  ): void {
    const program = this.gridProgram
    const from = this.fromGrid
    const to = this.toGrid ?? from
    if (!program || !from || !to) return

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(program)
    gl.bindVertexArray(this.vao)

    const loc = (name: string): WebGLUniformLocation | null => this.uGrid[name] ?? null
    gl.uniform2f(loc('uSize'), width, height)
    gl.uniform1f(loc('uDpr'), dpr)
    gl.uniform2f(loc('uTopLeft'), topLeftX, topLeftY)
    gl.uniform1f(loc('uScale'), scale)
    gl.uniform4f(loc('uBoundsA'), from.west, from.south, from.east, from.north)
    gl.uniform4f(loc('uBoundsB'), to.west, to.south, to.east, to.north)
    gl.uniform2f(loc('uGridSizeA'), from.cols, from.rows)
    gl.uniform2f(loc('uGridSizeB'), to.cols, to.rows)
    gl.uniform1f(loc('uOpacity'), this.opacity)
    gl.uniform1f(loc('uMinDbz'), this.paletteStops[0]!.dbz)
    gl.uniform1f(loc('uMaxDbz'), this.paletteStops[this.paletteStops.length - 1]!.dbz)
    const drift = from.drift
    const hasDrift = this.canDrift(this.pairFrom, this.pairTo)
    gl.uniform1f(loc('uBlend'), hasDrift ? this.blend : 0)
    gl.uniform1f(loc('uThresholdBias'), this.thresholdBias)
    gl.uniform1f(loc('uCohesion'), this.cohesion)
    gl.uniform1f(loc('uClassMode'), this.classMode ? 1 : 0)
    const flow = hasDrift ? drift?.flow : undefined
    gl.uniform2f(loc('uDrift'), hasDrift ? drift?.dLon ?? 0 : 0, hasDrift ? drift?.dLat ?? 0 : 0)
    gl.uniform1f(loc('uHasDrift'), hasDrift ? 1 : 0)
    gl.uniform4f(
      loc('uFlowBounds'),
      flow?.west ?? from.west,
      flow?.south ?? from.south,
      flow?.east ?? from.east,
      flow?.north ?? from.north
    )
    gl.uniform1f(loc('uHasFlow'), flow ? 1 : 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.gridTexA)
    gl.uniform1i(loc('uGridA'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, hasDrift ? this.gridTexB : this.gridTexA)
    gl.uniform1i(loc('uGridB'), 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex)
    gl.uniform1i(loc('uPalette'), 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.flowTex)
    gl.uniform1i(loc('uFlow'), 3)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private drawPolar(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    dpr: number,
    topLeftX: number,
    topLeftY: number,
    scale: number
  ): void {
    const program = this.program
    const from = this.fromSweep
    const to = this.toSweep ?? from
    if (!program || !from || !to) return

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(program)
    gl.bindVertexArray(this.vao)

    const loc = (name: string): WebGLUniformLocation | null => this.u[name] ?? null
    const meta = (sweep: NexradSweepPayload): [number, number, number, number] => [
      sweep.meta.firstGateKm,
      sweep.meta.gateSizeKm,
      sweep.meta.gateCount,
      sweep.meta.azimuthCount
    ]
    const site1 = this.fromSweep1
    const to1 = this.toSweep1 ?? site1
    gl.uniform2f(loc('uSize'), width, height)
    gl.uniform1f(loc('uDpr'), dpr)
    gl.uniform2f(loc('uTopLeft'), topLeftX, topLeftY)
    gl.uniform1f(loc('uScale'), scale)
    gl.uniform3f(loc('uSite0'), from.meta.lon, from.meta.lat, from.meta.elevationDeg)
    gl.uniform3f(
      loc('uSite1'),
      site1?.meta.lon ?? from.meta.lon,
      site1?.meta.lat ?? from.meta.lat,
      site1?.meta.elevationDeg ?? from.meta.elevationDeg
    )
    gl.uniform1f(loc('uSiteCount'), site1 ? 2 : 1)
    gl.uniform4f(loc('uMeta0A'), ...meta(from))
    gl.uniform4f(loc('uMeta0B'), ...meta(to))
    gl.uniform4f(loc('uMeta1A'), ...(site1 ? meta(site1) : meta(from)))
    gl.uniform4f(loc('uMeta1B'), ...(to1 ? meta(to1) : meta(to)))
    gl.uniform1f(loc('uOpacity'), this.opacity)
    gl.uniform1f(loc('uMinDbz'), this.paletteStops[0]!.dbz)
    gl.uniform1f(loc('uMaxDbz'), this.paletteStops[this.paletteStops.length - 1]!.dbz)
    gl.uniform1f(loc('uBlend'), 0)
    gl.uniform1f(loc('uThresholdBias'), this.thresholdBias)
    gl.uniform1f(loc('uCohesion'), this.cohesion)
    gl.uniform1f(loc('uClassMode'), this.classMode ? 1 : 0)

    const block0 =
      peekBlockageMap(from.meta.siteId, from.meta.elevationDeg) ??
      peekBlockageMap(from.meta.siteId)
    const block1 = site1
      ? (peekBlockageMap(site1.meta.siteId, site1.meta.elevationDeg) ??
        peekBlockageMap(site1.meta.siteId))
      : null
    if (!block0) {
      void ensureBlockageMap({
        siteId: from.meta.siteId,
        lat: from.meta.lat,
        lon: from.meta.lon,
        elevationDeg: from.meta.elevationDeg
      }).then(() => this.scheduleDraw())
    }
    if (site1 && !block1) {
      void ensureBlockageMap({
        siteId: site1.meta.siteId,
        lat: site1.meta.lat,
        lon: site1.meta.lon,
        elevationDeg: site1.meta.elevationDeg
      }).then(() => this.scheduleDraw())
    }
    const has0 = this.uploadBlockage(gl, this.blockTex0, block0, 'blockKey0')
    const has1 = this.uploadBlockage(gl, this.blockTex1, block1, 'blockKey1')
    gl.uniform1f(loc('uHasBlock0'), has0 ? 1 : 0)
    gl.uniform1f(loc('uHasBlock1'), has1 ? 1 : 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.polarTex0A)
    gl.uniform1i(loc('uPolar0A'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.polarTex0B)
    gl.uniform1i(loc('uPolar0B'), 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.polarTex1A)
    gl.uniform1i(loc('uPolar1A'), 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.polarTex1B)
    gl.uniform1i(loc('uPolar1B'), 3)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex)
    gl.uniform1i(loc('uPalette'), 4)
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_2D, this.blockTex0)
    gl.uniform1i(loc('uBlock0'), 5)
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, this.blockTex1)
    gl.uniform1i(loc('uBlock1'), 6)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}
