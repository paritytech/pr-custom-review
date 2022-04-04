import github from "@actions/github"
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods"

export type CommitState =
  RestEndpointMethodTypes["repos"]["createCommitStatus"]["parameters"]["state"]

export type Octokit = ReturnType<typeof github.getOctokit>

export type PR = {
  number: number
  base: {
    repo: {
      name: string
      owner: {
        login: string
      }
    }
  }
  head: {
    sha: string
  }
  user: {
    login: string
  }
  html_url: string
}

export type BaseRule = {
  name: string
  condition:
    | string
    | { include: string }
    | { exclude: string }
    | { include: string; exclude: string }
  check_type: "diff" | "changed_files"
}

export type RuleCriteria = {
  min_approvals: number
  name?: string
  users?: Array<string> | null
  teams?: Array<string> | null
}

export type BasicRule = BaseRule & RuleCriteria

export type OrRule = BaseRule & {
  any: RuleCriteria[]
}

export type AndRule = BaseRule & {
  all: RuleCriteria[]
}

export type AndDistinctRule = BaseRule & {
  all_distinct: RuleCriteria[]
}

export type RuleKind = "BasicRule" | "OrRule" | "AndRule" | "AndDistinctRule"
export type Rule = BasicRule | OrRule | AndRule | AndDistinctRule

export type RulesConfigurations = {
  basic: {
    kind: "BasicRule"
    uniqueFields: ["min_approvals", "teams", "users"]
    invalidFields: ["any", "all", "all_distinct"]
  }
  and: {
    kind: "AndRule"
    uniqueFields: ["all"]
    invalidFields: ["min_approvals", "teams", "users", "any", "all_distinct"]
  }
  or: {
    kind: "OrRule"
    uniqueFields: ["any"]
    invalidFields: ["min_approvals", "teams", "users", "all", "all_distinct"]
  }
  and_distinct: {
    kind: "AndDistinctRule"
    uniqueFields: ["all_distinct"]
    invalidFields: ["min_approvals", "teams", "users", "all", "any"]
  }
}

export type Configuration = {
  rules: Rule[]
  inputs: {
    "locks-review-team": string
    "team-leads-team": string
    "action-review-team": string
  }
  prevent_review_requests:
    | {
        users: string[]
        teams: string[]
      }
    | undefined
    | null
}

export type RuleUserInfo = {
  teams: Set<string> | null
  teamsHistory?: Set<string>
}

type MatchedRuleBase = {
  name: string
  users: Map<string, RuleUserInfo>
  id: number
  kind: RuleKind
  min_approvals: number
}
export type MatchedRule =
  | (MatchedRuleBase & {
      kind: "AndRule" | "OrRule" | "BasicRule"
    })
  | (MatchedRuleBase & {
      kind: "AndDistinctRule"
      subConditions: RuleCriteria[]
    })

export class RuleSuccess {
  constructor(public rule: MatchedRule) {}
}
export class RuleFailure {
  constructor(
    public rule: MatchedRule,
    public problem: string,
    public usersToAskForReview: Map<string, RuleUserInfo>,
  ) {}
}
