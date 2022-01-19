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
  diff_url: string
  html_url: string
}

export type BaseRule = {
  name: string
  condition: string
  check_type: "diff" | "changed_files"
}

export type RuleCriteria = {
  min_approvals: number
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

export type RuleKind = "BasicRule" | "OrRule" | "AndRule"
export type Rule = BasicRule | OrRule | AndRule

type RuleConfiguration<Kind extends RuleKind> = Kind extends "BasicRule"
  ? {
      kind: Kind
      uniqueFields: ["min_approvals", "teams", "users"]
      invalidFields: ["any", "all"]
    }
  : Kind extends "AndRule"
  ? {
      kind: Kind
      uniqueFields: ["all"]
      invalidFields: ["min_approvals", "teams", "users", "any"]
    }
  : Kind extends "OrRule"
  ? {
      kind: Kind
      uniqueFields: ["any"]
      invalidFields: ["min_approvals", "teams", "users", "all"]
    }
  : never
export type RulesConfigurations = {
  basic: RuleConfiguration<"BasicRule">
  and: RuleConfiguration<"AndRule">
  or: RuleConfiguration<"OrRule">
}

export type Configuration = {
  rules: Rule[]
}

export type RuleUserInfo = { team: string | null }

export type MatchedRule = {
  name: string
  min_approvals: number
  users: Map<string, RuleUserInfo>
  kind: RuleKind
  id: number
}

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
