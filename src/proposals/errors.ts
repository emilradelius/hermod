/** Typed errors of the knowledge services (memory, skills, proposals). */

export type ProposalRefusalCode =
  | "invalid"
  | "ungrounded"
  | "injection"
  | "not_applicable"
  | "not_allowed";

/** Thrown when a proposal is refused before it is stored (bad shape, ungrounded evidence, injection, …). */
export class ProposalRefusedError extends Error {
  readonly code: ProposalRefusalCode;
  readonly problems: string[];
  constructor(code: ProposalRefusalCode, problems: string[]) {
    super(`Proposal refused: ${problems.join(" ")}`);
    this.name = "ProposalRefusedError";
    this.code = code;
    this.problems = problems;
  }
}

export type SkillErrorCode =
  | "invalid_name"
  | "invalid_description"
  | "invalid_body"
  | "exists"
  | "not_found"
  | "injection"
  | "patch_not_found"
  | "patch_ambiguous"
  | "invalid_change";

/** Thrown by SkillService for a change it refuses. Nothing is written when it is thrown. */
export class SkillError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
