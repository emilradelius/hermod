/**
 * Who is a person: the one check that decides whether an actor may change a mode, score a draft or decide a
 * proposal. Hermod's own actors are named `<kind>` or `<kind>:<id>` (for example "agent:notes", "job:daily",
 * "review", "system"); none of them may ever decide anything, so the agent only proposes.
 *
 * The check is case-insensitive, ignores surrounding whitespace and folds look-alike characters (NFKC, so a
 * full-width "ａｇｅｎｔ:x" is caught too): "Agent:x", " JOB:x " and "Review" are not people.
 */

/** The actor kinds that are never a person. */
export const NON_HUMAN_ACTOR_KINDS: readonly string[] = Object.freeze([
  "agent",
  "job",
  "review",
  "system",
  "curator",
  "scheduler",
  "delegate",
]);

/** Matches a non-human actor (on the trimmed, NFKC-folded text): the kind alone, or the kind and a colon. */
export const NON_HUMAN_ACTOR_PATTERN = new RegExp(`^(?:${NON_HUMAN_ACTOR_KINDS.join("|")})\\s*(?::|$)`, "i");

/** True when `actor` names one of Hermod's own actors (agent, job, review, system, curator, scheduler, delegate). */
export function isNonHumanActor(actor: string): boolean {
  if (typeof actor !== "string") return false;
  let folded: string;
  try {
    folded = actor.normalize("NFKC").trim();
  } catch {
    folded = actor.trim();
  }
  return NON_HUMAN_ACTOR_PATTERN.test(folded);
}
