// GTA VI trophy rarity forecast — trend + dilution forecaster (Node 22, stdlib only).
//
// Idea, per trophy, from the case's own history only:
//  1. Weighted least squares of logit(rate) on x = ln(1 + hours since 2026-11-19T00:00Z),
//     recency-weighted over ALL reads (not just the last 24h).
//  2. Each trophy's slope is shrunk toward its tier's pooled slope (platinum/gold/silver/
//     bronze behave differently; early story bronzes rise fastest, platinum slowest).
//  3. Dilution is modelled separately: earners E = rate * players_tracked is
//     non-decreasing, so forecast E and players_tracked N (growth decelerates in
//     log-log) and combine rate = E / N with the trend extrapolation. A pure rate
//     trend is not allowed to run away when player growth is the main mover.
//  4. The median move is capped: |logit(median) - logit(last rate)| <= 1.5.
//  5. The spread is honest and wider than the house's where history justifies it:
//     base 0.5*sqrt(horizon_days), plus residual std and a jump/refresh allowance
//     (largest |delta logit| between consecutive reads), plus a refresh floor.
//     On a FLAT history the residual is 0 but refresh risk is real, so the floor
//     keeps the 90-min practice band from being as narrow as the house's (whose
//     coverage on practice was 0). A flat history also gets a small downward
//     dilution prior, since a refresh brings in players who hold fewer trophies.
//  6. Edge cases: a 100% rate stays ~100%; quantiles are clamped to [0.01, 99.99]
//     before any logit, are non-decreasing, in 0..100, one row per trophy.
//
// Deterministic: no randomness, no network, no Date.now() in the forecast path
// (all times come from the case file). Two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const EPOCH_MS = Date.parse('2026-11-19T00:00:00Z');
const MAX_MEDIAN_MOVE = 1.5;
const MAX_SIGMA = 1.6;

interface Trophy { id: number; tier: string }
interface Read { at: string; players_tracked: number; rates: Array<number | null> }
interface Case {
  levels: number[];
  horizon_minutes: number;
  at: string;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => {
  const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, l))));
  return Math.min(99.99, Math.max(0.01, p * 100));
};
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const hoursSinceEpoch = (iso: string): number =>
  (Date.parse(iso) - EPOCH_MS) / 3600000;

// Recency-weighted least squares of y on x. Returns slope, intercept, residual std.
function wls(xs: number[], ys: number[], ws: number[]): { slope: number; intercept: number; residStd: number } {
  let sw = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i]!;
    sw += w; sx += w * xs[i]!; sy += w * ys[i]!; sxx += w * xs[i]! * xs[i]!; sxy += w * xs[i]! * ys[i]!;
  }
  const denom = sw * sxx - sx * sx;
  let slope = 0; let intercept = sy / Math.max(sw, 1e-9);
  if (Math.abs(denom) > 1e-12) {
    slope = (sw * sxy - sx * sy) / denom;
    intercept = (sy - slope * sx) / sw;
  }
  let rss = 0; let wsum = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i]! - (intercept + slope * xs[i]!);
    rss += ws[i]! * r * r; wsum += ws[i]!;
  }
  const residStd = xs.length > 2 ? Math.sqrt(rss / Math.max(wsum, 1e-9)) : 0;
  return { slope, intercept, residStd };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  const hist = c.history;
  if (hist.length === 0) throw new Error(`${file} has no history`);
  const last = hist[hist.length - 1]!;
  const horizonDays = c.horizon_minutes / 1440;
  const xTarget = Math.log(1 + Math.max(0, hoursSinceEpoch(c.target)));
  const tLast = hoursSinceEpoch(last.at);
  // Dampen extrapolation: never read a fitted line more than 1.2 log-time
  // units past the last read. On the real final the gap is ~1.0, so this
  // barely binds there, but it stops a short history from running away
  // over a long horizon.
  const xLastHist = Math.log(1 + Math.max(0, tLast));
  const xEff = Math.min(xTarget, xLastHist + 1.2);
  const flatPlayers = last.players_tracked === hist[0]!.players_tracked;

  // Per-trophy trend fits, then tier-pooled slopes for shrinkage.
  type Fit = { slope: number; intercept: number; residStd: number; maxJump: number; lastLogit: number; xs: number[] };
  const fits: Fit[] = c.trophies.map((_t, i) => {
    const xs: number[] = []; const ys: number[] = []; const ws: number[] = [];
    let maxJump = 0; let prev: number | null = null;
    for (const r of hist) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined) continue;
      const l = logit(rate);
      if (prev !== null) maxJump = Math.max(maxJump, Math.abs(l - prev));
      prev = l;
      const t = hoursSinceEpoch(r.at);
      xs.push(Math.log(1 + Math.max(0, t)));
      ys.push(l);
      // Recency weight: half-life ~36h, so launch-night reads still count.
      ws.push(Math.exp(-(tLast - t) / 36));
    }
    const { slope, intercept, residStd } = wls(xs, ys, ws);
    const lastRate = last.rates[i] ?? 0;
    return { slope, intercept, residStd, maxJump, lastLogit: logit(lastRate), xs };
  });

  // Tier-pooled slope: weighted mean of individual slopes in each tier.
  const tierSlope = new Map<string, number>();
  for (const tier of ['platinum', 'gold', 'silver', 'bronze']) {
    let s = 0; let w = 0;
    c.trophies.forEach((t, i) => {
      if (t.tier !== tier) return;
      const n = fits[i]!.xs.length;
      if (n >= 3) { s += fits[i]!.slope * n; w += n; }
    });
    tierSlope.set(tier, w > 0 ? s / w : 0);
  }

  // Players-tracked growth in log-log: log N on ln(1+hours). Decelerating growth.
  const nXs: number[] = []; const nYs: number[] = []; const nWs: number[] = [];
  for (const r of hist) {
    if (r.players_tracked <= 0) continue;
    const t = hoursSinceEpoch(r.at);
    nXs.push(Math.log(1 + Math.max(0, t)));
    nYs.push(Math.log(r.players_tracked));
    nWs.push(Math.exp(-(tLast - t) / 36));
  }
  const nFit = wls(nXs, nYs, nWs);
  // Cap the log-log slope: player growth decelerates, never explodes.
  const nSlope = Math.max(0, Math.min(1.2, nFit.slope));
  const nPred = Math.max(
    last.players_tracked,
    Math.exp(nFit.intercept + nSlope * xEff), // damped extrapolation, see xEff
  );
  // Do not let the forecast player count run away on a short flat history:
  // at most ~8x the last count over the horizon (launch week is fast, not infinite).
  const nPredCapped = Math.min(nPred, last.players_tracked * 8);

  const trophies = c.trophies.map((t, i) => {
    const f = fits[i]!;
    const lastRate = last.rates[i] ?? 0;

    // The 100% trophy stays ~100%: everyone earns the opening trophy.
    if (lastRate >= 99.5) {
      return { id: t.id, q: [99.9, 99.95, 99.99, 99.99, 99.99] };
    }

    // Shrink this trophy's slope 60/40 toward its tier's pooled slope.
    const pooled = tierSlope.get(t.tier) ?? 0;
    const slope = f.xs.length >= 3 ? 0.6 * f.slope + 0.4 * pooled : pooled;
    const trendLogit = f.intercept + slope * xEff; // damped extrapolation

    // Dilution: forecast earners E in log-log, same shape as N.
    const eXs: number[] = []; const eYs: number[] = []; const eWs: number[] = [];
    for (const r of hist) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined) continue;
      const earners = Math.max(0, (rate / 100) * r.players_tracked);
      const tt = hoursSinceEpoch(r.at);
      eXs.push(Math.log(1 + Math.max(0, tt)));
      eYs.push(Math.log(earners + 0.5));
      eWs.push(Math.exp(-(tLast - tt) / 36));
    }
    const eFit = wls(eXs, eYs, eWs);
    const eSlope = Math.max(0, Math.min(1.5, eFit.slope));
    const eLast = Math.max(0, (lastRate / 100) * last.players_tracked);
    // eYs were log(earners + 0.5), so subtract the 0.5 back out.
    const ePred = Math.max(eLast, Math.exp(eFit.intercept + eSlope * xEff) - 0.5); // damped
    const dilRate = (ePred / nPredCapped) * 100;
    const dilLogit = logit(dilRate);

    // Combine trend and dilution equally when both are fitted, else trend only.
    let medianLogit = f.xs.length >= 3 ? 0.5 * trendLogit + 0.5 * dilLogit : trendLogit;
    // Flat history: no trend and no dilution signal, but a refresh is coming
    // (launch night proved it). Shift the median down a little: new players
    // hold fewer trophies, so rates fall at the next refresh.
    // Tolerances, not exact == 0: floating-point WLS residuals on a flat
    // history are ~1e-16, not exactly 0, and must still count as flat.
    if (flatPlayers && f.maxJump < 1e-9 && f.residStd < 1e-9) medianLogit -= 0.4;
    // Cap the median move so one noisy fit cannot blow up a trophy.
    medianLogit = Math.max(
      f.lastLogit - MAX_MEDIAN_MOVE,
      Math.min(f.lastLogit + MAX_MEDIAN_MOVE, medianLogit),
    );

    // Spread: random-walk base + residual + jump allowance + refresh floor.
    const base = 0.5 * Math.sqrt(horizonDays);
    const jumpAllow = Math.min(1.0, f.maxJump) * 0.5;
    const refreshFloor = 0.85;
    let sigma = Math.sqrt(
      base * base + f.residStd * f.residStd + jumpAllow * jumpAllow + refreshFloor * refreshFloor,
    );
    sigma = Math.min(MAX_SIGMA, Math.max(0.35, sigma));

    const q = Z.map((z) => round4(invLogitPct(medianLogit + z * sigma)));
    // Enforce non-decreasing (rounding can only tie, but be safe).
    for (let j = 1; j < q.length; j++) if (q[j]! < q[j - 1]!) q[j] = q[j - 1]!;
    return { id: t.id, q };
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
