# PR Custom Review (GiHub Action)

This is an action created for complex pull request approval scenarios that are not currently supported by the [protected branches](https://docs.github.com/en/github/administering-a-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#about-branch-protection-settings) feature in GitHub. It might extend or even completely replace [Require pull request reviews before merging](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#require-pull-request-reviews-before-merging) setting.

## How this action works

Once setup, PR Custom Review action executed at events [pull_request](https://docs.github.com/en/actions/learn-github-actions/events-that-trigger-workflows#pull_request) and [pull_request_review](https://docs.github.com/en/actions/learn-github-actions/events-that-trigger-workflows#pull_request_review) (see [workflow config example](#Workflow-config])).

When the action is triggered, it evaluates whether PR contains changes requiring special approval. Conditions for evaluation specified in action's [`config_file`](#Action-config) and currently supports two types of checks:

* `pr_diff` - examines PR diff content
* `pr_files` - evaluates paths/files changed in PR

If PR Custom Review action detects that one of the conditions returns positive result it will request PR review from users/teams specified in the [action's config](#Action-config) and sets status check as `failed` preventing PR from merge until specified approval reviews count is received.

Then PR Custom Review action monitors `pull_request_review` events, evaluates received reviews and updates PR status checks accordingly.

Review policy described in [action config](#Action-config) can be enforced by setting [status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks) of PR's as required in the protected branch settings (see [GitHub repository configuration](#GitHub-repository-configuration)).

## Configuration

### Action config

Action has one built-in condition check which evaluates whether PR changes any line of code containing 🔒 emoji sign or line below it.

Additional condition checks can be configured via the `pr-custom-review-config.yml` file placed in the `.github` subdirectory. Default config file can be overriden in workflow step [`with`](https://docs.github.com/en/actions/learn-github-actions/workflow-syntax-for-github-actions#jobsjob_idstepswith) section. [`config_file`](#Action-config) is optional and if it is missing than only built-in check will be performed.

Config file format:

```yaml
approval_groups:
  - name: CHECK NAME     # Used to create message in status check. Keep it short as description of status check has limit of 140 chars
    condition: /^.*$/    # RegExp used to detect changes. Do not specify modifiers after closing slash. "gm" modifiers will be added
    check_type: pr_diff  # Check type. Currently supported: `pr_diff` and `pr_files`
    min_approvals: 2     # Minimum required approvals
    users:               # GitHub users list to request review from
      - user1
      - user2
    teams:               # GitHub teams list to request review from. Must be within repository organization, teams from external organizations are not supported. Specify team name(slug) only e.g 'team1' without org. 'org/team1' will lead to failure.
      - team1
      - team2
```

### Workflow config

```yaml
name: PR Custom Review Status                     # Used to create status check name

on:                                               # Events which triggers action
  pull_request:
    branches:
      - main
      - master
    types:
      - opened
      - reopened
      - synchronize
      - review_request_removed                    # In addition to default events (opened, reopened, synchronize)
  pull_request_review:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: checkout
        uses: actions/checkout@v2                 # IMPORTANT! use this action as the first step
        with:
          fetch-depth: 0
      - name: pr-custom-review
        uses: paritytech/pr-custom-review@master  # This action, please stick to the release, not master
        with:
          token: ${{ secrets.GITHUB_TOKEN }}            # If it is needed to request reviews from teams, then token with permission to read organization is needed. Default one created by GitHub action will fail.
          config-file: './.github/pr-custom-review-config.yml' # OPTIONAL: can be specified to override default config_file
```

### GitHub repository configuration

Although action will work even without any additional settings in GitHub repository.
It is recommended to setup [Branch protection rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/managing-a-branch-protection-rule) as shown on the screenshot below:

<details>
<summary>Expand screenshot</summary>

![Branch protection settings](./img/github-branch-protection.png)

</details>

### High level flow chart
![High level flow chart](./img/pr-custom-review-flowchart.png)