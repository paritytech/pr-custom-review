import { GitHub } from "@actions/github/lib/utils";
import { OctokitResponse } from "@octokit/types";
import YAML from "yaml";

import { configFilePath, maxGithubApiFilesPerPage, maxGithubApiReviewsPerPage } from "src/constants";
import { Configuration, Context, PR } from "src/types";
import { configurationSchema } from "src/validation";

import { ActionLoggerInterface } from "./action/logger";

export interface Review {
  state: "COMMENTED" | "REQUEST_CHANGES" | "APPROVE" | string;
  user?: { id: number; login: string } | null;
  id: number;
}

export class GitHubApi {
  private readonly octokit: InstanceType<typeof GitHub>;
  private readonly logger: ActionLoggerInterface;
  constructor(private readonly pr: PR, { octokit, logger }: Context) {
    this.octokit = octokit;
    this.logger = logger;
  }

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

  async fetchDiff(): Promise<string> {
    const diffResponse = (await this.octokit.rest.pulls.get({
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      mediaType: { format: "diff" },
    })) /* Octokit doesn't inform the right return type for mediaType: { format: "diff" } */ as unknown as OctokitResponse<string>;
    return diffResponse.data;
  }

  async fetchChangedFiles(): Promise<string[]> {
    const data = await this.octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      per_page: maxGithubApiFilesPerPage,
    });
    return data.map(({ filename }) => filename);
  }

  async fetchReviews(): Promise<Review[]> {
    return await this.octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: this.pr.base.repo.owner.login,
      repo: this.pr.base.repo.name,
      pull_number: this.pr.number,
      per_page: maxGithubApiReviewsPerPage,
    });
  }
}
