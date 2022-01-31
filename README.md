# PR Custom Review

This is a GitHub Action created for complex pull request approval scenarios which are not currently supported by GitHub's [Branch Protection Rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#about-branch-protection-rules). It might extend or even completely replace the [Require pull request reviews before merging](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#require-pull-request-reviews-before-merging) setting.

# TOC

- [How it works](#how-it-works)
  - [High level flow chart](#high-level-flow-chart)
- [Built-in checks](#built-in-checks)
- [Configuration](#configuration)
  - [Action configuration](#action-configuration)
  - [Rules syntax](#rules-syntax)
    - [Basic Rule syntax](#basic-rule-syntax)
    - [AND Rule syntax](#and-rule-syntax)
    - [OR Rule syntax](#or-rule-syntax)
  - [Workflow configuration](#workflow-configuration)
  - [GitHub repository configuration](#github-repository-configuration)
- [Development](#development)
  - [Build](#build)
    - [Build steps](#build-steps)
  - [Trial](#trial)
    - [Trial steps](#trial-steps)
  - [Release](#release)
    - [Release steps](#release-steps)

## How it works <a name="how-it-works"></a>

Upon receiving [pull_request](https://docs.github.com/en/actions/learn-github-actions/events-that-trigger-workflows#pull_request) and [pull_request_review](https://docs.github.com/en/actions/learn-github-actions/events-that-trigger-workflows#pull_request_review) events (to be enabled via [workflow configuration](#workflow-configuration)), this action evaluates all rules described in the [configuration file](#action-configuration). Currently two types of rules are supported:

- `diff` which matches a rule based on the PR's diff content
- `changed_files` which matches a rule based on paths/files changed in the PR

If a given rule is matched and its approval count is not met, then reviews will be requested from the missing users/teams for that rule and a failed commit status will be set for the PR; this status can be made a requirement through branch protection rules in order to block the PR from being merged until all conditions are passing (see [GitHub repository configuration](#github-repository-configuration)).

### High level flow chart

![High level flow chart](./img/pr-custom-review-flowchart.png)

## Built-in checks <a name="built-in-checks"></a>

This action has the following non-configurable built-in checks:

- Lines which have a lock emoji (🔒) or any line directly below a lock emoji
  require:
  - 1 approval from [locks-review-team](#workflow-configuration)
  - 1 approval from [team-leads-team](#workflow-configuration)

- If the action's files are changed, 1 approval from
  [action-review-team](#workflow-configuration) is required
  - `.github/workflows/pr-custom-review.yml` 
  - `.github/pr-custom-review.yml` 

Customizable rules should be enabled through [configuration](#action-configuration).

## Configuration

### Action configuration <a name="action-configuration"></a>

The configuration file should be placed in `.github/pr-custom-review.yml`
(related to [built-in checks](#built-in-checks)).

### Rules syntax <a name="rules-syntax"></a>

Three kinds of rules are available:

- Basic Rule, through which you specify **top-level** `users` and `teams` for
  reaching `min_approvals`

- AND Rule, through which you specify subconditions of `users` and `teams`, each
  with its own `min_approvals`, and **all** of them (logical `AND`) should
  reach their respective `min_approvals`

- OR Rule, through which you specify subconditions of `users` and `teams`, each
  with its own `min_approvals`, and **any** of them (logical `OR`) should reach
  their respective `min_approvals`

It's not possible to mix fields from different rules kinds. For instance, it's
invalid to specify a **top-level** `min_approvals` for AND or OR rules: the
criteria should be put in the subconditions instead.

#### Basic Rule syntax <a name="basic-rule-syntax"></a>

```yaml
rules:
  - name: Rule name      # Used for the status check description. Keep it short
                         # as GitHub imposes a limit of 140 chars.
    condition: .*        # Javascript Regular Expression used to match the rule.
                         # Do not include RegExp delimiters (`/`) at the
                         # beginning or end.
                         # "gm" modifiers will be added by the action.
    check_type: diff     # Either "diff" or "changed_files".
    min_approvals: 2     # Minimum required approvals.
    users:
    # GitHub users which should be requested for reviews.
      - user1
      - user2
    teams:
    # GitHub teams which should be requested for reviews.
    # This refers to teams from the same organization as the repository where
    # this action is running.
    # Specify the teams only by name, without the organization part.
    # e.g. 'org/team1' will not work.
      - team1
      - team2
```

#### AND Rule syntax <a name="and-rule-syntax"></a>

AND Rules will only match if **all** subconditions listed in `all` are
fulfilled.

```yaml
rules:
  - name: Rule name
    condition: .*
    check_type: diff
    all:
      - min_approvals: 1
        users:
          - user1
      - min_approvals: 1
        users:
          - user2
        teams:
          - team1
```

Visit [Basic Rule syntax](#basic-rule-syntax) for the full explanation of each
field.

#### OR Rule syntax <a name="or-rule-syntax"></a>

OR Rules will match if **any** subconditions listed in `any` are fulfilled.

```yaml
rules:
  - name: Rule name
    condition: .*
    check_type: diff
    any:
      - min_approvals: 1
        users:
          - user1
      - min_approvals: 1
        users:
          - user2
        teams:
          - team1
```

Visit [Basic Rule syntax](#basic-rule-syntax) for the full explanation of each
field.

### Workflow configuration <a name="workflow-configuration"></a>

The workflow configuration should be placed in
`.github/workflows/pr-custom-review.yml` (related to
[built-in checks](#built-in-checks)).

```yaml
name: PR Custom Review Status    # The PR status will be created with this name.

on:                              # The events which will trigger the action.
  pull_request:                  # A "pull_request" event of selected types will trigger the action.
    branches:                    # Action will be triggered if a PR is made to following branches.
      - main
      - master
    types:                       # Types of "pull_request" event which will trigger the action.
      - opened                   # Default event - PR is created.
      - reopened                 # Default event - closed PR is reopened.
      - synchronize              # Default event - PR is changed.
      - review_request_removed   # Requested reviewer removed from PR. Action will re-request its review if it's required.
  pull_request_review:           # PR review received. Action will check whether PR meets required review rules.

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: pr-custom-review
        uses: paritytech/pr-custom-review@tag           # Pick a release tag and put it after the "@".
        with:
          # A token with read-only organization permission is required for
          # requesting reviews from teams.
          token: ${{ secrets.GITHUB_TOKEN }}

          # The team which will handle the "locks touched" built-in rule.
          locks-review-team: my-custom-team

          # The second team which will handle the "locks touched" built-in rule.
          team-leads-team: my-custom-leads-team

          # The team which will handle the changes to the action's configuration.
          action-review-team: my-action-review-team
```

### GitHub repository configuration  <a name="github-repository-configuration"></a>

Although the action will work even without any additional [repository settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features), for maximum enforcement effectiveness it is recommended to enable
[Branch Protection Rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/managing-a-branch-protection-rule) according to the screenshot below:

![Branch Protection Settings](./img/github-branch-protection.png)

## Development

### Build

Build revolves around compiling the code and packaging it with
[ncc](https://github.com/vercel/ncc). Since the build output consists of plain
.js files, which can be executed directly by Node.js, it _could_ be ran
directly without packaging first; we regardless prefer to use `ncc` because it
bundles all the code (_including the dependencies' code_) into a single file
ahead-of-time, meaning the workflow can promptly run the action without having
to download dependencies first.

#### Build steps <a name="build-steps"></a>

1. Install the dependencies

`npm install`

2. Build

`npm run build`

3. Package

`npm run package`

See the next sections for [trying it out](#trial) or [releasing](#release).

### Trial

A GitHub workflow will always clone the HEAD of
`${organization}/${repo}@${ref}` **when the action executes**, as exemplified
by the following line:

`uses: paritytech/pr-custom-review@branch`

Therefore any changes pushed to the branch will automatically be applied the
next time the action is ran.

#### Trial steps <a name="trial-steps"></a>

1. [Build](#build) the changes and push them to some branch
2. Change the workflow's step from `paritytech/pr-custom-review@branch` to your
  branch:

```diff
-uses: paritytech/pr-custom-review@branch
+uses: user/fork@branch
```

3. Re-run the action and note the changes were automatically applied

### Release

A GitHub workflow will always clone the HEAD of
`${organization}/${repo}@${tag}` **when the action executes**, as exemplified
by the following line:

`uses: paritytech/pr-custom-review@tag`

That behavior makes it viable to release by committing build artifacts directly
to a tag and then using the new tag in the repositories where this action is
installed.

#### Release steps <a name="release-steps"></a>

1. [Build](#build) the changes and push them to some tag
2. Use the new tag in your workflows:

```diff
-uses: paritytech/pr-custom-review@1
+uses: paritytech/pr-custom-review@2
```

### Testing

Run `npm run test`.

Test logging is saved to [snapshots](./test/batch) (`.snap` files). If your
code changes affect some snapshot then review the modifications and run `npm
run test -- -u`.
