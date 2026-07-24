export type EarlyAccessTier = 'A' | 'B' | 'C';

export type EarlyAccessResult = {
  score: number;
  tier: EarlyAccessTier;
  signals: string[];
};

type Signal = { label: string; pattern: RegExp; weight: number };

const POSITIVE: Signal[] = [
  { label: 'gray rollout', pattern: /灰度|灰度发布|灰度测试|小范围|小批量|小批次|逐步推出|limited rollout|limited release|phased rollout|small batch/i, weight: 3 },
  { label: 'invite-only', pattern: /邀请制|邀请注册|邀请码|invite[- ]?only|by invitation|private beta/i, weight: 3 },
  { label: 'waitlist', pattern: /候补名单|等候名单|排队|waitlist|waiting list/i, weight: 2 },
  { label: 'beta', pattern: /内测|公测|测试版|beta(?:\s+test|\s+release)?/i, weight: 2 },
  { label: 'developer preview', pattern: /开发者预览|开发者测试|developer preview|dev(?:eloper)?[- ]?preview|early access/i, weight: 3 },
  { label: 'application release', pattern: /应用(?:程序)?发布|应用上线|app(?:lication)?\s+(?:release|launch)|mobile\s+app\s+(?:release|launch)/i, weight: 1 },
];

const NEGATIVE: Signal[] = [
  { label: 'ordinary release', pattern: /正式发布|全面上线|全量发布|现已开放|面向所有用户|一般可用|正式版|正式推出|发布|上线|新品|general availability|generally available|now available to everyone|full release|official release|new product/i, weight: -1 },
];

export function scoreEarlyAccessSignals(text: string): EarlyAccessResult {
  const signals: string[] = [];
  let score = 0;
  for (const signal of [...POSITIVE, ...NEGATIVE]) {
    if (signal.pattern.test(text)) {
      signals.push(signal.label);
      score += signal.weight;
    }
  }
  const tier: EarlyAccessTier = score >= 5 ? 'A' : score >= 2 ? 'B' : 'C';
  return { score, tier, signals };
}
