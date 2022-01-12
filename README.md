# PR Custom Review

This is a GitHub Action created for complex pull request approval scenarios which are not currently supported by GitHub's [Branch Protection Rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#about-branch-protection-rules). It might extend or even completely replace the [Require pull request reviews before merging](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#require-pull-request-reviews-before-merging) setting.

# TOC

- [How it works](#how-it-works)
  - [High level flow chart](#high-level-flow-chart)
- [Configuration](#configuration)
  - [Action configuration](#action-configuration)
    - [Rules syntax](#rules-syntax)
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

- `pr_diff` which matches a rule based on the PR's diff content
- `pr_files` which matches a rule based on paths/files changed in the PR

If a given rule is matched and its approval count is not met, then reviews will be requested from the missing users/teams for that rule and a failed commit status will be set for the PR; this status can be made a requirement through branch protection rules in order to block the PR from being merged until all conditions are passing (see [GitHub repository configuration](#github-repository-configuration)).

This action has one built-in check which reacts to changes in lines of code containing the `🔒` emoji or any line directly below it. Any further checks should be enabled through [configuration](#action-configuration).

### High level flow chart
![High level flow chart](./img/pr-custom-review-flowchart.png)

## Configuration

### Action configuration <a name="action-configuration"></a>

Configuration is done through a `pr-custom-review-config.yml` file placed in the `.github` directory. The default location can be overridden through [`step.with`](https://docs.github.com/en/actions/learn-github-actions/workflow-syntax-for-github-actions#jobsjob_idstepswith) as demonstrated in [Workflow configuration](#workflow-configuration).

The configuration file is **optional** and if it is missing then only built-in check will be performed.

#### Rules syntax <a name="rules-syntax"></a>

```yaml
approval_rules:
  - name: CHECK NAME     # Used for the status check description. Keep it short
                         # as GitHub imposes a limit of 140 chars.
    condition: /^.*$/    # Javascript Regular Expression used to match the rule.
                         # Do not specify modifiers after the closing slash.
                         # "gm" modifiers will be added by the action.
    check_type: pr_diff  # Either "pr_diff" or "pr_files".
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

### Workflow configuration <a name="workflow-configuration"></a>

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
      # Use actions/checkout before pr-custom-review so that the PR's branch
      # will be cloned (required for "pr_diff" rules).
      - name: checkout
        uses: actions/checkout@v2
        with:
          fetch-depth: 0
      - name: pr-custom-review
        uses: paritytech/pr-custom-review@tag           # Pick a release tag and put it after the "@".
        with:
          # Custom token with read-only organization permission is required for
          # requesting reviews from teams. The inherent action token will not
          # work for this.
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: './.github/pr-custom-review-config.yml' # OPTIONAL: can be specified to override default config_file
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
