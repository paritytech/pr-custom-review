import * as core from "@actions/core"
import * as github from "@actions/github"
import { Context } from "@actions/github/lib/context"
import * as Webhooks from "@octokit/webhooks-types"
import * as fs from "fs"
import Joi from "joi"
import * as YAML from "yaml"

type Octokit = ReturnType<typeof github.getOctokit>

type ApprovalRule = {
  name: string
  condition: string
  check_type: "pr_diff" | "pr_files"
  min_approvals: number
  users: Array<string> | undefined
  teams: Array<string> | undefined
}
const approvalRuleSchema = Joi.object<ApprovalRule>().keys({
  name: Joi.string().required(),
  condition: Joi.string().required(),
  check_type: Joi.string().valid("pr_diff", "pr_files").required(),
  min_approvals: Joi.number().required(),
  users: Joi.array().items(Joi.string()),
  teams: Joi.array().items(Joi.string()),
})
type RulesConfiguration = {
  approval_rules: ApprovalRule[]
}
const rulesConfigurationSchema = Joi.object<RulesConfiguration>().keys({
  approval_rules: Joi.array().items(approvalRuleSchema).required(),
})

export function checkCondition(
  check_type: string,
  condition: RegExp,
  pr_diff_body: { data: string },
  pr_files_list: Set<string>,
): boolean {
  console.log(`###### BEGIN checkCondition ######`) //DEBUG
  var condition_match: boolean = false
  console.log(`condition: ${condition}`) //DEBUG
  if (check_type === "pr_diff") {
    if (pr_diff_body.data.match(condition) !== null) {
      console.log(`Condition ${condition} matched`) //DEBUG
      condition_match = true
    }
  }
  if (check_type === "pr_files") {
    for (const item of pr_files_list) {
      if (item.match(condition)) {
        console.log(`Condition ${condition} matched`) //DEBUG
        condition_match = true
      }
    }
  }
  console.log(`###### END checkCondition ######`) //DEBUG
  return condition_match
}

export async function combineUsersTeams(
  client: Octokit,
  context: Context,
  org: string,
  pr_owner: string,
  users: string[],
  teams: string[],
): Promise<string[]> {
  const full_approvers_list: Set<string> = new Set()
  console.log(`###### BEGIN combineUsersTeams ######`) //DEBUG
  console.log(`Users inside combine func: ${users} - `) //DEBUG
  for (const user of users) {
    if (pr_owner != user) {
      console.log(`user: ${user}`) //DEBUG
      full_approvers_list.add(user)
    }
  }
  console.log(`Teams inside combine func: ${teams}  - org: ${org}`) //DEBUG
  for (const team of teams) {
    console.log(`Team: ${team}`) //DEBUG
    const team_users_list = await client.rest.teams.listMembersInOrg({
      ...context.repo,
      org: org,
      team_slug: team,
    })

    for (const member of team_users_list.data) {
      console.log(`team_member: ${member!.login!}`) //DEBUG
      if (pr_owner != member!.login) {
        full_approvers_list.add(member!.login)
      }
    }
  }
  console.log(
    `Resulting full_approvers_list: ${Array.from(full_approvers_list)}`,
  ) //DEBUG
  console.log(`###### END combineUsersTeams ######`) //DEBUG
  return Array.from(full_approvers_list)
}

export async function assignReviewers(
  client: Octokit,
  reviewer_users: string[],
  reviewer_teams: string[],
  pr_number: number,
) {
  try {
    console.log(`###### BEGIN assignReviewers ######`) //DEBUG
    console.log(`users: ${reviewer_users.length} - ${reviewer_users}`) //DEBUG
    // You're safe to use default GITHUB_TOKEN until you request review only from users not teams
    // If teams review is needed, then PAT token required with permission to read org
    if (reviewer_users.length !== 0) {
      await client.rest.pulls.requestReviewers({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr_number,
        reviewers: reviewer_users,
      })
      core.info(`Requested review from users: ${reviewer_users}.`)
    }
    console.log(`teams: ${reviewer_teams.length} - ${reviewer_teams}`) //DEBUG
    if (reviewer_teams.length !== 0) {
      await client.rest.pulls.requestReviewers({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr_number,
        team_reviewers: reviewer_teams,
      })
      core.info(`Requested review from teams: ${reviewer_teams}.`)
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error : String(error))
    console.log("error: ", error)
  }
  console.log(`###### END assignReviewers ######`) //DEBUG
}

async function run(): Promise<void> {
  console.log(`###### BEGIN PR-CUSTOM-CHECK ACTION ######`)
  try {
    type ApprovalRule = {
      name: string
      min_approvals: number
      users?: string[]
      teams?: string[]
      approvers: string[]
    }
    const final_approval_rules: ApprovalRule[] = []

    const context = github.context

    if (
      context.eventName !== "pull_request" &&
      context.eventName !== "pull_request_review"
    ) {
      core.setFailed(
        `Invalid event: ${context.eventName}. This action should be triggered on pull_request and pull_request_review`,
      )
      return
    }

    const payload = context.payload as
      | Webhooks.PullRequestEvent
      | Webhooks.PullRequestReviewEvent

    const octokit = github.getOctokit(core.getInput("token"))
    const pr_number = payload.pull_request.number
    const pr_owner = payload.pull_request.user.login
    const sha = payload.pull_request.head.sha
    const workflow_name = process.env.GITHUB_WORKFLOW
    const workflow_url = `${process.env["GITHUB_SERVER_URL"]}/${process.env["GITHUB_REPOSITORY"]}/actions/runs/${process.env["GITHUB_RUN_ID"]}`
    const organization = process.env.GITHUB_REPOSITORY?.split("/")[0]!
    const pr_diff_body: { data: string } = await octokit.request(
      payload.pull_request.diff_url,
    )
    const pr_files = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: pr_number,
      },
    )
    // Retrieve PR's changes files
    const pr_files_list: Set<string> = new Set()
    for (var i = 0; i < pr_files.data.length; i++) {
      var obj = pr_files.data[i]
      pr_files_list.add(obj.filename)
    }
    console.log(
      `###### PR FILES LIST ######\n ${Array.from(pr_files_list).join(
        "\n",
      )}\n######`,
    )

    var CUSTOM_REVIEW_REQUIRED: boolean = false
    const pr_status_messages: string[] = []
    const pr_review_status_messages: string[] = []

    // Built in condition to search files with changes to locked lines
    const search_locked_lines_regexp: RegExp = /🔒.*(\n^[+|-].*)|^[+|-].*🔒/gm
    if (pr_diff_body.data.match(search_locked_lines_regexp) !== null) {
      console.log(`###### TOUCHED LOCKS FOUND ######`) //DEBUG
      console.log(pr_diff_body.data.match(search_locked_lines_regexp)) //DEBUG
      CUSTOM_REVIEW_REQUIRED = true
      var approvers: string[] = await combineUsersTeams(
        octokit,
        context,
        organization,
        pr_owner,
        [],
        ["pr-custom-review-team"],
      )
      final_approval_rules.push({
        name: "LOCKS TOUCHED",
        min_approvals: 2,
        users: [],
        teams: ["pr-custom-review-team"],
        approvers: approvers,
      })
      console.log(final_approval_rules) //DEBUG
      pr_status_messages.push(`LOCKS TOUCHED review required`)
    }

    // Read values from config file if it exists
    console.log(`###### CONFIG FILE EVALUATION ######`) //DEBUG
    if (fs.existsSync(core.getInput("config-file"))) {
      const config_file = fs.readFileSync(core.getInput("config-file"), "utf8")
      const validation_result = rulesConfigurationSchema.validate(
        YAML.parse(config_file),
      )
      if (validation_result.error) {
        console.error("Configuration file is invalid", validation_result.error)
        core.setFailed(validation_result.error)
        process.exit(1)
      }
      const config_file_contents = validation_result.value

      for (const approval_rule of config_file_contents.approval_rules) {
        console.log(`approval_rule: ${approval_rule.name}`) //DEBUG
        const condition: RegExp = new RegExp(approval_rule.condition, "gm")

        if (
          checkCondition(
            approval_rule.check_type,
            condition,
            pr_diff_body,
            pr_files_list,
          )
        ) {
          CUSTOM_REVIEW_REQUIRED = true
          // Combine users and team members in `approvers` list, excluding pr_owner
          var allApprovers: string[] = await combineUsersTeams(
            octokit,
            context,
            organization,
            pr_owner,
            approval_rule.users ?? [],
            approval_rule.teams ?? [],
          )
          final_approval_rules.push({
            name: approval_rule.name,
            min_approvals: approval_rule.min_approvals,
            users: approval_rule.users,
            teams: approval_rule.teams,
            approvers: allApprovers,
          })
          console.log(`###### APPROVAL RULES ######`) //DEBUG
          console.log(final_approval_rules)
          pr_status_messages.push(
            `${approval_rule.name} ${approval_rule.min_approvals} review(s) required`,
          )
        }
      }
    } else {
      console.log(
        `No config file provided. Continue with built in approval rule`,
      )
    }

    // No breaking changes - no cry. Set status OK and exit.
    if (!CUSTOM_REVIEW_REQUIRED) {
      console.log(`###### Special approval of this PR is not required. ######`) //DEBUG
      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: "success",
        context: workflow_name,
        target_url: workflow_url,
        description: "Special approval of this PR is not required.",
      })
      return
    }

    // Refine data for review request
    const reviewer_users_set: Set<string> = new Set()
    const reviewer_teams_set: Set<string> = new Set()

    for (const reviewers of final_approval_rules) {
      if (reviewers.users) {
        for (var user of reviewers.users) {
          if (user !== pr_owner) {
            reviewer_users_set.add(user)
          }
        }
      }
      if (reviewers.teams) {
        for (var team of reviewers.teams) {
          reviewer_teams_set.add(team)
        }
      }
    }

    console.log(`users set: ${Array.from(reviewer_users_set)}`) //DEBUG
    console.log(`teams set: ${Array.from(reviewer_teams_set)}`) //DEBUG

    // if event pull_request, will request reviews and set check status 'failure'
    if (context.eventName == "pull_request") {
      console.log(
        `###### It's a PULL REQUEST event! I'm going to request needed approvals!!! ######`,
      ) //DEBUG
      assignReviewers(
        octokit,
        Array.from(reviewer_users_set),
        Array.from(reviewer_teams_set),
        pr_number,
      )
      console.log(`STATUS MESSAGES: ${pr_status_messages.join()}`) //DEBUG
      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: "failure",
        context: workflow_name,
        target_url: workflow_url,
        description: pr_status_messages.join("\n"),
      })
    } else {
      console.log(
        `###### It's a PULL REQUEST REVIEW event! I don't care about requesting approvals! Will just check who already approved`,
      )
      //retrieve approvals
      console.log(`###### GETTING PR REVIEWS ######`) //DEBUG
      const reviews = await octokit.rest.pulls.listReviews({
        ...context.repo,
        pull_number: pr_number,
      })
      const approved_users: Set<string> = new Set()
      for (const review of reviews.data) {
        if (review.state === `APPROVED`) {
          approved_users.add(review.user!.login)
          console.log(`${review.state} - ${review.user!.login}`) //DEBUG
        } else {
          approved_users.delete(review.user!.login)
          console.log(`${review.state} - ${review.user!.login}`) //DEBUG
        }
      }
      console.log(`Approved users: ${Array.from(approved_users)}`) //DEBUG

      // check approvals
      console.log(`###### CHECKING APPROVALS ######`) //DEBUG
      const has_all_needed_approvals: Set<string> = new Set()

      for (const rule of final_approval_rules) {
        const rule_approvers = new Set(rule.approvers)
        const has_approvals = new Set(
          [...rule_approvers].filter((x) => approved_users.has(x)),
        )
        console.log(
          `Need min ${rule.min_approvals} approvals from ${
            rule.approvers
          } --- has ${has_approvals.size} - ${Array.from(has_approvals)}`,
        ) //DEBUG
        if (has_approvals.size >= rule.min_approvals) {
          has_all_needed_approvals.add("true")
          pr_review_status_messages.push(
            `${rule.name} (${has_approvals.size}/${rule.min_approvals})- OK!`,
          )
        } else {
          has_all_needed_approvals.add("false")
          pr_review_status_messages.push(
            `${rule.name} (${has_approvals.size}/${rule.min_approvals})`,
          )
        }
      }

      // The workflow url can be obtained by combining several environment varialbes, as described below:
      // https://docs.github.com/en/actions/reference/environment-variables#default-environment-variables
      core.info(`Setting a status on commit (${sha})`)
      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: has_all_needed_approvals.has("false") ? "failure" : "success",
        context: workflow_name,
        target_url: workflow_url,
        description: pr_review_status_messages.join("\n"),
      })

      if (has_all_needed_approvals.has("false")) {
        core.setFailed(pr_review_status_messages.join("\n"))
        return
      }
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error : String(error))
    console.log("error: ", error)
  }
}

run()
