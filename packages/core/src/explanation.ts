export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SymbolBlastRadius {
  symbolName: string;
  filePath: string;
  referencesCount: number;
  referencingFiles: string[];
}

export interface DependencyDelta {
  packageName: string;
  version: string;
  isDev: boolean;
  status: "added" | "updated" | "removed";
  license?: string;
  securityNote?: string;
}

export interface ComprehensionQuestion {
  id: string;
  questionText: string;
  options: string[];
  correctOptionIndex: number;
  explanation: string;
}

export interface ExplanationReport {
  sessionId: string;
  gitCommitSha: string;
  riskLevel: RiskLevel;
  summary: string;
  blastRadius: SymbolBlastRadius[];
  dependencyChanges: DependencyDelta[];
  potentialRisks: string[];
  comprehensionQuestions?: ComprehensionQuestion[];
  generatedAt: number;
}
