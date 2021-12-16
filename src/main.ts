import * as core from '@actions/core'
import * as github from '@actions/github'
import * as Webhooks from '@octokit/webhooks-types'
import * as fs from 'fs'
import * as YAML from 'yaml'
import { Context } from '@actions/github/lib/context'

export function checkCondition(check_type: string, condition: RegExp, pr_diff_body: any, pr_files_list: Set<string>): boolean {
  var condition_match: boolean = false
  if (check_type == 'pr_diff') {
    if (pr_diff_body.data.match(condition)) {
      condition_match = true
    }
  }
  if (check_type == 'pr_files') {
    for (const item of pr_files_list) {
      if (item.match(condition)) {
        condition_match = true
      }
    }
  }
  return condition_match
}

export async function combineUsersTeams(client: any, context: Context, org: string, pr_owner: string, users: string[], teams: string[]): Promise<string[]> {
  const full_approvers_list: Set<string> = new Set()
  if (users) {
    for (const user of users) {
      if (pr_owner != user) {
        full_approvers_list.add(user)
      }
    }
  }
  if (teams) {
    for (const team of teams) {
      const team_users_list = await client.rest.teams.listMembersInOrg({
        ...context.repo,
        org: org,
        team_slug: team
      })
      for (const member of team_users_list.data) {
        if (pr_owner != member!.login) {
          full_approvers_list.add(member!.login)
        }
      }
    }
  }
  return Array.from(full_approvers_list)
}

export async function assignReviewers(client: any, reviewer_users: string[], reviewer_teams: string[], pr_number: number) {
  try {
    // You're safe to use default GITHUB_TOKEN until you request review only from users not teams
    // It teams review is needed, then PAT token required
    if (reviewer_users) {
      await client.rest.pulls.requestReviewers({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr_number,
        reviewers: reviewer_users,
      });
      core.info(`Requested review from users: ${reviewer_users}.`);
    }

    if (reviewer_teams) {
      await client.rest.pulls.requestReviewers({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr_number,
        team_reviewers: reviewer_teams,
      });
      core.info(`Requested review from teams: ${reviewer_teams}.`);
    }
  } catch (error) {
    core.setFailed(error.message)
    console.log("error: ", error)
  }
}

async function run(): Promise<void> {
  try {
    type ApprovalGroup = { name: string, min_approvals: number, users?: string[], teams?: string[], approvers: string[] }
    const final_approval_groups: ApprovalGroup[] = []
    const context = github.context

    if (
      context.eventName !== 'pull_request' &&
      context.eventName !== 'pull_request_review'
    ) {
      core.setFailed(
        `Invalid event: ${context.eventName}. This action should be triggered on pull_request and pull_request_review`
      )
      return
    }

    const payload = context.payload as
      | Webhooks.PullRequestEvent
      | Webhooks.PullRequestReviewEvent

    const token: string = core.getInput('token')
    const octokit = github.getOctokit(token)
    const repo = payload.repository.url
    const pr_number = payload.pull_request.number
    const pr_diff_url = payload.pull_request.diff_url
    const pr_owner = payload.pull_request.user.login
    const sha = payload.pull_request.head.sha
    const workflow_name = `${process.env.GITHUB_WORKFLOW}`
    const workflow_url = `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
    const organization: string = process.env.GITHUB_REPOSITORY?.split("/")[0]!
    const pr_diff_body = await octokit.request(pr_diff_url)
    const pr_files = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: pr_number
    })
    // Retrieve pr files list
    const pr_files_list: Set<string> = new Set()
    for (var i = 0; i < pr_files.data.length; i++) {
      var obj = pr_files.data[i]
      pr_files_list.add(obj.filename)
    }

    var CUSTOM_REVIEW_REQUIRED: boolean = false
    const pr_status_messages: string[] = []
    const pr_review_status_messages: string[] = []

    // condition to search files with changes to locked lines
    const search_locked_lines_regexp = /🔒.*(\n^[\+|\-].*)|^[\+|\-].*🔒/gm

    if (pr_diff_body.data.match(search_locked_lines_regexp)) {
      CUSTOM_REVIEW_REQUIRED = true
      var approvers: string[] = []
      await combineUsersTeams(octokit, context, organization, pr_owner, [], ['s737team']).then(value => {
        console.log(`value: ${value}`)
        approvers = value
      })
      console.log(`Approvers: ${approvers}`)
      final_approval_groups.push({ name: 'LOCKS TOUCHED', min_approvals: 2, users: [], teams: ['s737team'], approvers: approvers })

      pr_status_messages.push(`LOCKS TOUCHED review required`)
    }


    // Read values from config file if it exists
    var config_file_contents: any = ""
    if (fs.existsSync(core.getInput('config-file'))) {
      const config_file = fs.readFileSync(core.getInput('config-file'), 'utf8')
      config_file_contents = YAML.parse(config_file)

      for (const approval_group of config_file_contents.approval_groups) {
        const condition: RegExp = new RegExp(approval_group.condition, "gm")
        if (checkCondition(approval_group.check_type, condition, pr_diff_body, pr_files_list)) {
          CUSTOM_REVIEW_REQUIRED = true
          // Combine users and team members in `approvers` list, excluding pr_owner
          var approvers: string[] = []
          await combineUsersTeams(octokit, context, organization, pr_owner, approval_group.users, approval_group.teams).then(value => {
            console.log(`value: ${value}`)
            approvers = value
          })

          final_approval_groups.push({
            name: approval_group.name,
            min_approvals: approval_group.min_approvals,
            users: approval_group.users,
            teams: approval_group.teams,
            approvers: approvers
          })
          pr_status_messages.push(`${approval_group.name} review required`)
        }
      }
    } else {
      console.log(`No config file provided. Continue with built in approval group`)
    }

    // No breaking changes - no cry. Set status OK and exit.
    if (!CUSTOM_REVIEW_REQUIRED) {
      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: 'success',
        context: workflow_name,
        target_url: workflow_url,
        description: "Special approval of this PR is not required."
      })
      return
    }

    // Refine data for review request
    const reviewer_users_set: Set<string> = new Set()
    const reviewer_teams_set: Set<string> = new Set()

    for (const reviewers of final_approval_groups) {
      if (reviewers.users) {
        for (var entry of reviewers.users) {
          if (entry != pr_owner) {
            reviewer_users_set.add(entry)
          }
        }
      }
      if (reviewers.teams) {
        for (var entry of reviewers.teams) {
          reviewer_teams_set.add(entry)
        }
      }
    }
    if (context.eventName == 'pull_request') {
      assignReviewers(octokit, Array.from(reviewer_users_set), Array.from(reviewer_teams_set), pr_number)

      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: 'failure',
        context: workflow_name,
        target_url: workflow_url,
        description: pr_status_messages.join('\n')
      })
    } else {
      console.log(`I don't care about requesting approvals! Will just check who already approved`)


      //retrieve approvals
      const reviews = await octokit.rest.pulls.listReviews({
        ...context.repo,
        pull_number: payload.pull_request.number
      })
      const approved_users: Set<string> = new Set()
      for (const review of reviews.data) {
        if (review.state === `APPROVED`) {
          approved_users.add(review.user!.login)
        } else {
          approved_users.delete(review.user!.login)
        }
      }

      // check approvals
      const has_all_needed_approvals: Set<string> = new Set()
      for (const group of final_approval_groups) {
        const group_approvers = new Set(group.approvers)
        const has_approvals = new Set([...group_approvers].filter(x => approved_users.has(x)))
        if (has_approvals.size >= group.min_approvals) {
          has_all_needed_approvals.add('true')
          pr_review_status_messages.push(
            `${group.name} has enough (${has_approvals.size}) approvals`
          )
        } else {
          has_all_needed_approvals.add('false')
          pr_review_status_messages.push(
            `${group.name} min ${group.min_approvals} reviewers should approve this PR (currently: ${has_approvals.size})`
          )
        }

      }

      // The workflow url can be obtained by combining several environment varialbes, as described below:
      // https://docs.github.com/en/actions/reference/environment-variables#default-environment-variables
      core.info(`Setting a status on commit (${sha})`)

      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: has_all_needed_approvals.has('false') ? 'failure' : 'success',
        context: workflow_name,
        target_url: workflow_url,
        description: pr_review_status_messages.join('\n')
      })

      if (has_all_needed_approvals.has('false')) {
        core.setFailed(pr_review_status_messages.join('\n'))
        return
      }
    }
  } catch (error) {
    core.setFailed(error.message)
    console.log("error: ", error)
  }
}

run()
