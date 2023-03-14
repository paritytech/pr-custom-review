import { GitHub } from "@actions/github/lib/utils";
import { OctokitResponse } from "@octokit/types";
import YAML from "yaml";

import {
  configFilePath,
  maxGithubApiFilesPerPage,
  maxGithubApiReviewsPerPage,
  maxGithubApiTeamMembersPerPage,
} from "src/constants";
import { Configuration, Context, PR } from "src/types";
import { configurationSchema } from "src/validation";

import { ActionLoggerInterface } from "./action/logger";

export interface Review {
  state: "COMMENTED" | "REQUEST_CHANGES" | "APPROVE" | string;
  user?: { id: number; login: string } | null;
  id: number;
}

/** Class in charge of interacting with GitHub. */
export class GitHubApi {
  private readonly octokit: InstanceType<typeof GitHub>;
  private readonly logger: ActionLoggerInterface;

  constructor(private readonly pr: PR, { octokit, logger }: Context) {
    this.octokit = octokit;
    this.logger = logger;
  }

  /** Fetches the config file and validates that is the correct type/format */
  async fetchConfigFile(): Promise<Configuration | null> {
    const configFileResponse = await this.octokit.rest.repos.getContent({
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      path: configFilePath,
    });
    if (!("content" in configFileResponse.data)) {
      this.logger.fatal(`Did not find "content" key in the response for ${configFilePath}`);
      this.logger.info(configFileResponse.data);
      return null;
    }

    const { content: configFileContentsEnconded } = configFileResponse.data;
    if (typeof configFileContentsEnconded !== "string") {
      this.logger.fatal(`Content response for ${configFilePath} had unexpected type (expected string)`);
      this.logger.info(configFileResponse.data);
      return null;
    }

    const configFileContents = Buffer.from(configFileContentsEnconded, "base64").toString("utf-8");

    const configValidationResult = configurationSchema.validate(YAML.parse(configFileContents));
    if (configValidationResult.error) {
      this.logger.fatal("Configuration file is invalid");
      this.logger.info(configValidationResult.error);
      return null;
    }

    return configValidationResult.value;
  }

  /** Fetches the diff in the PR */
  async fetchDiff(): Promise<string> {
    const diffResponse = (await this.octokit.rest.pulls.get({
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      mediaType: { format: "diff" },
    })) /* Octokit doesn't inform the right return type for mediaType: { format: "diff" } */ as unknown as OctokitResponse<string>;
    return diffResponse.data;
  }

  /** Returns a list of all files that were changed */
  async fetchChangedFiles(): Promise<string[]> {
    const data = await this.octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      per_page: maxGithubApiFilesPerPage,
    });
    return data.map(({ filename }) => filename);
  }

  /** Fetches the list of reviews to a repo
   * Includes comments and failed reviews
   */
  async fetchReviews(): Promise<Review[]> {
    return await this.octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      per_page: maxGithubApiReviewsPerPage,
    });
  }

  /** Request users/teams to review this PR */
  async requestReviewers(users: string[], teams: string[]): Promise<void> {
    await this.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      reviewers: users,
      team_reviewers: teams,
    });
  }

  /** Gets all the members belonging to a team */
  async getTeamMembers(team_slug: string): Promise<string[]> {
    return await this.octokit.paginate(
      this.octokit.rest.teams.listMembersInOrg,
      { org: this.pr.base.repo.owner.login, team_slug, per_page: maxGithubApiTeamMembersPerPage },
      (response) => response.data.map(({ login }) => login),
    );
  }
}
