import * as core from '@actions/core'
import * as github from '@actions/github'
import * as Webhooks from '@octokit/webhooks-types'
import * as fs from 'fs'
import * as YAML from 'yaml'
import { EOL } from 'os'
import { Settings, ReviewGatekeeper } from './review_gatekeeper'

export async function assignReviewers(client: any, reviewer_persons: string[], pr_number: number) {
  try {
    console.log(`entering assignReviewers`)
    if (reviewer_persons.length) {
      await client.rest.pulls.requestReviewers({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr_number,
        reviewers: reviewer_persons[0],
      });
      core.info(`Requested review from: ${reviewer_persons}.`);
    }
    console.log(`exiting assignReviewers`)
  } catch (error) {
    core.setFailed(error.message)
    console.log("error: ", error)
  }
}

async function run(): Promise<void> {
  try {
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
    const pr_number = payload.pull_request.number
    const sha = payload.pull_request.head.sha
    const custom_review_required = process.env.CUSTOM_REVIEW_REQUIRED
    const workflow_url = `${process.env['GITHUB_SERVER_URL']}/${process.env['GITHUB_REPOSITORY']}/actions/runs/${process.env['GITHUB_RUN_ID']}`
    const workflow_name = `${process.env.GITHUB_WORKFLOW}`

    // No breaking changes - no cry. Set status OK and exit.
    if ( custom_review_required == 'not_required' ) {
      console.log(`Special approval of this PR is not required.`)

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

    // Read values from config file if it exists
    const config_file = fs.readFileSync(core.getInput('config-file'), 'utf8')

    // Parse contents of config file into variable
    const config_file_contents = YAML.parse(config_file)

    const reviewer_persons: string[] = []
    for (const reviewers of config_file_contents.approvals.groups) {
      reviewer_persons.push(reviewers.from.person)
    }

    // Request reviews if eventName == pull_request
    if (context.eventName == 'pull_request') {
      console.log(`I'm going to request someones approval!!!`)
      assignReviewers(octokit, reviewer_persons, pr_number)

      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: 'failure',
        context: workflow_name,
        target_url: workflow_url,
        description: `PR contains changes subject to special review. Review requested from: ${reviewer_persons.join(', ')}`
      })

    } else {
      console.log(`I don't care about requesting approvals! We'll just check who already approved`)

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
      const review_gatekeeper = new ReviewGatekeeper(
        config_file_contents as Settings,
        Array.from(approved_users),
        payload.pull_request.user.login
      )

      // The workflow url can be obtained by combining several environment varialbes, as described below:
      // https://docs.github.com/en/actions/reference/environment-variables#default-environment-variables
      core.info(`Setting a status on commit (${sha})`)


      octokit.rest.repos.createCommitStatus({
        ...context.repo,
        sha,
        state: review_gatekeeper.satisfy() ? 'success' : 'failure',
        context: workflow_name,
        target_url: workflow_url,
        description: review_gatekeeper.satisfy()
          ? undefined
          : review_gatekeeper.getMessages().join(' ')
      })

      if (!review_gatekeeper.satisfy()) {
        core.setFailed(review_gatekeeper.getMessages().join(EOL))
        return
      }
    }
  } catch (error) {
    core.setFailed(error.message)
    console.log("error: ", error)
  }
}

run()
