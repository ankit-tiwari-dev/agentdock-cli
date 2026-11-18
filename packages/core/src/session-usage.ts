/** Token use and cost of one model within one session, as the CLI stores it in `session_usage`. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Priced with the catalog at the time it was written. */
  costUsd: number;
  /** The model is not in the price catalog, so costUsd is an estimate at the default rate. */
  unknownModel: boolean;
  turns: number;
}
