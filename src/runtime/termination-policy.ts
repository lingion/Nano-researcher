export interface TerminationAssessment {
  shouldBreak: boolean;
  interruptedByGate: boolean;
  finalQualityStatus?: string;
  finalQualityReason?: string;
}

export function assessLoopTermination(input: {
  currentIteration: number;
  maxIterations: number;
  lastCandidateQualityState?: {
    status?: string;
    reason?: string;
  };
  agentDecisionType?: string;
  convergencePhase?: 'post_convergence_review' | 'final_summary';
}): TerminationAssessment {
  if (
    (input.agentDecisionType === 'finalize' || input.agentDecisionType === 'stop')
    && input.convergencePhase !== 'post_convergence_review'
  ) {
    return {
      shouldBreak: true,
      interruptedByGate: false,
    };
  }

  if (input.currentIteration >= input.maxIterations) {
    return {
      shouldBreak: true,
      interruptedByGate: true,
      finalQualityStatus: input.lastCandidateQualityState?.status ?? 'unknown_interrupted',
      finalQualityReason: input.lastCandidateQualityState?.reason ?? 'Forced iteration cutoff.',
    };
  }

  return {
    shouldBreak: false,
    interruptedByGate: false,
  };
}
