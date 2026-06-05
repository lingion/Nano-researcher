import type { CandidateTier } from './tiering.ts';

export interface DecisionContext {
  topic: string;
  candidate: {
    finalUrl: string;
    title: string;
    contentPreview: string;
  };
  source: {
    tier: CandidateTier;
    semanticNote: string;
    isTrustedOfficialDomain: boolean;
    isOfficialPdf: boolean;
  };
  signals: {
    exactTitleMatch: boolean;
    derivativeLike: boolean;
    formatRisk: boolean;
    isAmbiguous: boolean;
  };
  verificationStrategy: string[];
  modelInstructions: string[];
}
