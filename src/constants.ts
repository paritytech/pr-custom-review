import { AndRule, BasicRule, CommitState, OrRule } from "./types"

export const commitStateSuccess: CommitState = "success"
export const commitStateFailure: CommitState = "failure"

// Fields used for detecting the different kinds of rules
export const simpleRuleUniqueFields: Array<keyof BasicRule> = [
  "min_approvals",
  "teams",
  "users",
]
export const andRuleUniqueFields: Array<keyof AndRule> = ["all"]
export const orRuleUniqueFields: Array<keyof OrRule> = ["any"]
