export interface RankedEvaluationItem {
  id: string;
  relevance: number;
}

export interface RankingMetrics {
  k: number;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  relevantCount: number;
}

function dcg(values: number[]): number {
  return values.reduce((sum, relevance, index) => sum + ((2 ** relevance) - 1) / Math.log2(index + 2), 0);
}

export function evaluateRanking(ranked: RankedEvaluationItem[], relevantIds: Iterable<string>, k: number): RankingMetrics {
  const limit = Math.max(1, Math.floor(k));
  const relevant = new Set(relevantIds);
  const top = ranked.slice(0, limit);
  const hits = top.filter((item) => relevant.has(item.id));
  const reciprocalIndex = ranked.findIndex((item) => relevant.has(item.id));
  const ideal = [...ranked]
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, limit)
    .map((item) => item.relevance);
  const actual = top.map((item) => item.relevance);
  const idealDcg = dcg(ideal);
  return {
    k: limit,
    precisionAtK: hits.length / limit,
    recallAtK: relevant.size ? hits.length / relevant.size : 0,
    reciprocalRank: reciprocalIndex < 0 ? 0 : 1 / (reciprocalIndex + 1),
    ndcgAtK: idealDcg ? dcg(actual) / idealDcg : 0,
    relevantCount: relevant.size,
  };
}
