# PR Custom Review

This is an action created for complex pull request approval cases that are not currently supported by the [protected branches](https://docs.github.com/en/github/administering-a-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#about-branch-protection-settings) feature in GitHub.

## How this action works

This action is intended to be executed every time some change is made to the pull request (see [workflow example](#Workflow-config])). When this action is executed, it checks whether the review and approval status of the triggered pull request meets the policy described in the [action's config](#Action-config), and sets the result to a commit status named using name of the workflow-config. Therefore multiple workflows can be created with different names.

You can enforce the review policy described in action config by setting status of the workflow as required in the protected branch settings.

## Configuration

### Action config

The action is configured via the `custom_approvers_config.yml` file located in the `.github` subdirectory. Default config file can be overriden in workflow inputs.
The general format is as follows.

```yaml
approvals:
  # check will fail if there is no approval
  minimum: 1     # OPTIONAL - the same as repo protected branch settings
  groups:        # Multiple groups with can be specified
    - name: reviewers_group1
      minimum: 1 # number of needed approvals from the group
      from:
        person: # list of individual users to request and check approvals. Works with default GITHUB_TOKEN
          - user1
          - user2
    - name: reviewers_group2
      minimum: 2
      from:
        person:
          - user3
          - user4
```

### Workflow config

Once the `custom_approvers_config.yml` file is in place, add the action to execute on every PR and then set its status as required to start enforcing your new approval policy!

```yaml
name: 'PR-CUSTOM-REVIEW' # Name is used for creation of the PR commit status

on:
  pull_request:
    types:
      [
        assigned,
        unassigned,
        opened,
        reopened,
        synchronize,
        review_requested,
        review_request_removed
      ]
  pull_request_review:

jobs:
  pr-custom-review-job:
    runs-on: ubuntu-latest
    steps:
      - name: Evaluation # Evaluation performed whether PR needs custom review
        id: condition_check # IMPORTANT! Outputs of the step with this id will be used later
        run: |
          # SOME CONDITION EVALUATION
          if [ CONDITION = true ]
            then
              echo '::set-output name=CUSTOM_REVIEW_REQUIRED::required'
            else
              echo '::set-output name=CUSTOM_REVIEW_REQUIRED::not_required'
          fi

      - name: pr-custom-review
        uses: paritytech/pr-custom-review@master
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: './.github/custom_approvers_config.yml' #OPTIONAL if not specified default './.github/custom_approvers_config.yml' path will be used
        env:
          CUSTOM_REVIEW_REQUIRED: ${{ steps.condition_check.outputs.CUSTOM_REVIEW_REQUIRED }
```

### Diagram
![Diagram](./img/pr-custom-review-diagram.png)