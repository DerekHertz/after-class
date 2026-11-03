// providers/claude/adapter.ts -- ClaudePort over cli.ts. Maps zod outputs to domain types; every call goes through metered().
import type { Clock } from "../../../shared/core/clock";
import type { ClaudePort } from "../ports";
import type { Ledger } from "../metered";
import type { ProviderConfig } from "../index";

/**
 * Each method: prompt builder -> runStructured(schema) inside metered() -> map to domain.
 *   interpret : InterpretOut -> ClaimVersion[] with check:null. Code (core/claimMachine.validateDraft) validates evidence ids afterwards, not here.
 *   tutorTurn : streamStructured(TutorOut): yield header, say_delta*, then done{proposal}
 *               (claimId stays a plain ClaimId proposal; acceptTutorMove decides whether it becomes a SupportedClaimId).
 * Concurrency: a semaphore of cfg.claude.maxConcurrent across all methods (each is a child process).
 * Model/effort come from cfg.claude.choice[stage]; the stage is in CallCtx.
 */
export function createClaude(cfg: ProviderConfig["claude"], ledger: Ledger, clock: Clock): ClaudePort {
  throw new Error("not implemented");
}
