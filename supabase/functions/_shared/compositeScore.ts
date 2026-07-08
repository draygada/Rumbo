/**
 * Computes composite quality score from a deep reflection.
 * distraction is inverted: 5 = not distracted = good → (6 - distraction)
 * Range: 1.0 (worst) to 5.0 (best)
 */
export function compositeScore(
  productivity: number,  // 1–5
  energy: number,        // 1–5
  distraction: number,   // 1–5, higher = more distracted = worse
): number {
  return (productivity + energy + (6 - distraction)) / 3
}
