/**
 * Procedural ambient loops (QĐ-128 follow-up), made on this machine with
 * FFmpeg, $0. Each is light on black, because the compositor SCREEN-blends
 * ambient over the picture: black leaves it untouched.
 *
 * Every motion is periodic in the clip length, so `-stream_loop` repeats it
 * without a visible jump. Drawn small (geq is per pixel) and scaled up with a
 * blur, which also keeps the shapes soft.
 */

export const AMBIENT_LOOP = { width: 720, height: 1280, fps: 24, seconds: 6 } as const;

/** Phase that completes exactly one turn per loop. */
const P = `(2*PI*T/${AMBIENT_LOOP.seconds})`;

/** Grey-level expressions (0-255) over a 360x640 canvas. */
const RECIPES: Record<string, { lum: string; blur: number }> = {
  // Soft banks drifting right across the top of the frame.
  clouds: {
    lum:
      `200*clip((0.5+0.5*sin(X/40-${P}+1.3*sin(Y/23)))*(0.5+0.5*sin(Y/18+0.7*sin(X/55+${P})))-0.35,0,1)` +
      `*max(0,1-Y/(H*0.45))`,
    blur: 8,
  },
  // A plume rising from the bottom centre, widening and fading as it climbs.
  smoke: {
    lum: `170*exp(-pow((X-W/2-25*sin(Y/45+${P}))/(18+(H-Y)/10),2))*(0.6+0.25*sin(Y/31+2*${P})+0.15*sin(Y/9+X/23+4*${P}))*pow(Y/H,0.7)`,
    blur: 10,
  },
  // Thinner, fainter and shorter than smoke: from a cup in the lower middle.
  steam: {
    lum: `120*exp(-pow((X-W/2-12*sin(Y/30+${P}))/(10+(H-Y)/22),2))*(0.6+0.25*sin(Y/21+2*${P})+0.15*sin(Y/7+X/17+4*${P}))*clip(Y/H*1.8-0.6,0,1)*clip((H*0.92-Y)/(H*0.1),0,1)`,
    blur: 7,
  },
  // Six soft bokeh lights, each pulsing at its own whole-number rate.
  lights: {
    lum: [
      [70, 120, 1, 0],
      [260, 90, 2, 1.7],
      [180, 230, 3, 0.6],
      [60, 420, 2, 2.4],
      [300, 380, 1, 3.1],
      [200, 560, 3, 4.2],
    ]
      .map(([x, y, k, ph]) => `exp(-(pow(X-${x},2)+pow(Y-${y},2))/700)*(0.55+0.45*sin(${k}*${P}+${ph}))`)
      .join("+")
      .replace(/^/, "190*(")
      .concat(")"),
    blur: 3,
  },
  // Glints moving over the lower part of the frame.
  water: {
    lum: `140*pow(0.5+0.5*sin(Y/3.5+2.2*sin(X/37-${P})+2*${P}),6)*pow(0.5+0.5*sin(X/7+3*sin(Y/11)-${P}),3)*clip((Y-H*0.6)/(H*0.15),0,1)`,
    blur: 2,
  },
};

export const GENERATED_AMBIENT_KINDS = Object.keys(RECIPES);

export function buildAmbientLoopArgs(kind: string, output: string): string[] {
  const recipe = RECIPES[kind];
  if (!recipe) throw new Error(`Không có công thức ambient cho "${kind}".`);
  const { width, height, fps, seconds } = AMBIENT_LOOP;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=360x640:r=${fps}:d=${seconds}`,
    "-vf",
    `format=gray,geq=lum='${recipe.lum}',scale=${width}:${height}:flags=bicubic,gblur=sigma=${recipe.blur},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "22",
    "-an",
    "-movflags",
    "+faststart",
    output,
  ];
}

// ------------------------------------------------------- alpha (G3) loops ---

/**
 * TRANSPARENT ambient loops (.webm, VP9 with alpha): things that must be
 * drawn OVER the background, not lit into it - cars, passers-by, birds,
 * falling leaves. Distant and soft on purpose (small, slightly blurred): they
 * give the background life without pulling the eye from the subject.
 * Each is drawn on its own band canvas (the compositor places the band).
 */

/** Canvas per kind (the drawing is done small, then scaled up and blurred a touch). */
interface AlphaRecipe {
  /** Drawing size; output is 2x. */
  w: number;
  h: number;
  /** r, g, b, a expressions of X, Y, T (0..255). */
  r: string;
  g: string;
  b: string;
  a: string;
  blur: number;
}

const S = AMBIENT_LOOP.seconds;
/** Wrap a moving coordinate so the loop repeats exactly: travels `k` canvas widths (+ margin) per loop. */
const wrapX = (x0: number, period: number, k: number, dir: 1 | -1) => `mod(X-${x0}${dir > 0 ? "-" : "+"}${(period * k) / S}*T+${period * 4},${period})`;

/** Far cars on a road band: body, lighter windows, dark wheels, moving right in two lanes. */
function trafficRecipe(): AlphaRecipe {
  const W = 360;
  const cw = 44;
  const P = W + cw;
  const cars = [
    { x0: 0, yb: 52, ch: 16, k: 1, c: [170, 40, 40] },
    { x0: 150, yb: 52, ch: 15, k: 1, c: [40, 70, 150] },
    { x0: 260, yb: 34, ch: 12, k: 1, c: [215, 215, 210] },
    { x0: 80, yb: 34, ch: 12, k: 1, c: [60, 60, 60] },
  ];
  const parts = cars.map(({ x0, yb, ch, k, c }) => {
    const u = wrapX(x0, P, k, 1);
    const w = (ch / 16) * cw;
    const body = `lt(${u},${w})*between(Y,${yb - ch},${yb})*gt(Y,${yb - ch}+lt(${u},${w * 0.15})*${ch * 0.5}+gt(${u},${w * 0.85})*${ch * 0.5})`;
    const win = `between(${u},${w * 0.28},${w * 0.72})*between(Y,${yb - ch},${yb - ch * 0.55})`;
    const wheel = `(lt(hypot(${u}-${w * 0.22},Y-${yb}),${ch * 0.26})+lt(hypot(${u}-${w * 0.78},Y-${yb}),${ch * 0.26}))`;
    return { body, win, wheel, c };
  });
  const any = (f: (p: (typeof parts)[number]) => string) => `min(1,${parts.map(f).join("+")})`;
  const colour = (k: 0 | 1 | 2) => parts.map((p) => `${p.body}*(${p.win}*${Math.min(255, p.c[k]! + 70)}+(1-${p.win})*${p.c[k]})`).join("+");
  return {
    w: W,
    h: 60,
    r: `min(255,${colour(0)})*(1-${any((p) => p.wheel)})+${any((p) => p.wheel)}*25`,
    g: `min(255,${colour(1)})*(1-${any((p) => p.wheel)})+${any((p) => p.wheel)}*25`,
    b: `min(255,${colour(2)})*(1-${any((p) => p.wheel)})+${any((p) => p.wheel)}*25`,
    a: `255*${any((p) => `max(${p.body},${p.wheel})`)}`,
    blur: 0.8,
  };
}

/** Distant passers-by: head + body + bobbing walk, walking left, varied clothes. */
function pedestriansRecipe(): AlphaRecipe {
  const W = 360;
  const P = W + 20;
  const people = [
    { x0: 20, s: 1, c: [60, 80, 140] },
    { x0: 120, s: 0.9, c: [150, 60, 60] },
    { x0: 210, s: 1.05, c: [70, 110, 70] },
    { x0: 300, s: 0.85, c: [120, 100, 80] },
  ];
  const parts = people.map(({ x0, s, c }) => {
    const u = wrapX(x0, P, 1, -1);
    const bob = `${s * 1.2}*abs(sin(2*PI*T*1.8+${x0}))`;
    const head = `lt(hypot(${u}-6,Y-(${50 - 36 * s}-${bob})),${3.2 * s})`;
    const body = `between(${u},${6 - 3.5 * s},${6 + 3.5 * s})*between(Y,${50 - 32 * s}-${bob},${50 - 12 * s})`;
    const legs = `between(Y,${50 - 12 * s},50)*(lt(abs(${u}-6-2*sin(2*PI*T*1.8+${x0})),1.4)+lt(abs(${u}-6+2*sin(2*PI*T*1.8+${x0})),1.4))`;
    return { head, body, legs, c };
  });
  const sum = (f: (p: (typeof parts)[number]) => string) => parts.map(f).join("+");
  const ch = (k: 0 | 1 | 2) => `min(255,${sum((p) => `${p.body}*${p.c[k]}+${p.head}*${[205, 165, 135][k]}+${p.legs}*40`)})`;
  return { w: W, h: 56, r: ch(0), g: ch(1), b: ch(2), a: `255*min(1,${sum((p) => `${p.head}+${p.body}+${p.legs}`)})`, blur: 0.7 };
}

/** Small birds far away: a "V" that flaps, gliding right with a slow rise and fall. */
function birdsRecipe(): AlphaRecipe {
  const W = 360;
  const P = W + 40;
  const birds = [
    { x0: 0, y: 40, s: 1 },
    { x0: 40, y: 52, s: 0.8 },
    { x0: 170, y: 30, s: 0.9 },
    { x0: 260, y: 62, s: 0.7 },
    { x0: 300, y: 45, s: 0.75 },
  ];
  const wing = birds.map(({ x0, y, s }) => {
    const u = `(${wrapX(x0, P, 1, 1)}-20)`;
    const yy = `(Y-${y}-3*sin(2*PI*T/${S}+${x0}))`;
    const flap = `(0.35+0.3*sin(2*PI*T*3+${x0}))`;
    return `lt(abs(${yy}+${flap}*abs(${u})),${1.1 * s})*lt(abs(${u}),${7 * s})`;
  });
  return { w: W, h: 100, r: "40", g: "45", b: "55", a: `255*min(1,${wing.join("+")})`, blur: 0.5 };
}

/** Falling leaves across the whole frame: small swaying ellipses, warm greens and yellows. */
function leavesRecipe(): AlphaRecipe {
  const W = 180;
  const H = 320;
  const leaves = Array.from({ length: 9 }, (_, i) => ({ x0: (i * 47) % W, y0: (i * 137) % H, c: i % 3 === 0 ? [200, 170, 40] : i % 3 === 1 ? [110, 160, 50] : [160, 120, 40] }));
  const parts = leaves.map(({ x0, y0, c }) => {
    const y = `mod(Y-${y0}-${H / S}*T,${H})`;
    const x = `(X-${x0}-8*sin(2*PI*T*0.6+${y0}))`;
    return { m: `lt(hypot(${x}/3.2,(${y}-${H / 2})/1.6),1)`, c };
  });
  const ch = (k: 0 | 1 | 2) => `min(255,${parts.map((p) => `${p.m}*${p.c[k]}`).join("+")})`;
  return { w: W, h: H, r: ch(0), g: ch(1), b: ch(2), a: `255*min(1,${parts.map((p) => p.m).join("+")})`, blur: 0.6 };
}

const ALPHA_RECIPES: Record<string, () => AlphaRecipe> = {
  traffic: trafficRecipe,
  pedestrians: pedestriansRecipe,
  birds: birdsRecipe,
  leaves: leavesRecipe,
};

export const GENERATED_ALPHA_KINDS = Object.keys(ALPHA_RECIPES);

/** A transparent loop (.webm VP9 + alpha), drawn small and scaled up 2x. */
export function buildAlphaAmbientLoopArgs(kind: string, output: string): string[] {
  const make = ALPHA_RECIPES[kind];
  if (!make) throw new Error(`Không có công thức ambient trong suốt cho "${kind}".`);
  const r = make();
  const { fps, seconds } = AMBIENT_LOOP;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black@0.0:s=${r.w}x${r.h}:r=${fps}:d=${seconds}`,
    "-vf",
    `format=rgba,geq=r='${r.r}':g='${r.g}':b='${r.b}':a='${r.a}',scale=${r.w * 2}:${r.h * 2}:flags=bicubic,gblur=sigma=${r.blur}:planes=15`,
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-b:v",
    "0",
    "-crf",
    "32",
    "-auto-alt-ref",
    "0",
    "-deadline",
    "good",
    "-cpu-used",
    "4",
    "-an",
    output,
  ];
}
