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

export type Rule = {
  name: string
  condition: string
  check_type: "diff" | "changed_files"
  min_approvals: number
  users: Array<string> | undefined | null
  teams: Array<string> | undefined | null
}

export type Configuration = {
  rules: Rule[]
}

export type RuleUserInfo = { team: string | null }
