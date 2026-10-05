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
