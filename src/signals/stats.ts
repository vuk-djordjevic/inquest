/** Small, dependency-free statistics helpers used by the signal formulas. */

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5)
}

export interface Fences {
  q1: number
  median: number
  q3: number
  iqr: number
  upper: number
  n: number
}

/** Tukey fences: an observation above Q3 + 1.5 x IQR is a statistical outlier. */
export function tukeyFences(values: number[]): Fences {
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  return { q1, median: quantile(sorted, 0.5), q3, iqr, upper: q3 + 1.5 * iqr, n: sorted.length }
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10)
}

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, x))
}

export function round(x: number, digits = 0): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

export function formatRsd(x: number): string {
  return `${Math.round(x).toLocaleString("en-US")} RSD`
}

export function pct(x: number, digits = 0): string {
  return `${round(x * 100, digits)}%`
}
