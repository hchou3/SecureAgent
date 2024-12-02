import {
  BranchDetails,
  BuilderResponse,
  CodeSuggestion,
  Review,
  processGitFilepath,
  importedFunctions,
  PRFile,
  PatchInfo,
} from "./constants";
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import * as diff from "diff";
import { fileFromPath } from "groq-sdk";

const postGeneralReviewComment = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  review: string
) => {
  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.pull_request.number,
        body: review,
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }
    );
  } catch (exc) {
    console.log(exc);
  }
};

const postInlineComment = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  suggestion: CodeSuggestion
) => {
  try {
    const line = suggestion.line_end;
    let startLine = null;
    if (suggestion.line_end != suggestion.line_start) {
      startLine = suggestion.line_start;
    }
    const suggestionBody = `${suggestion.comment}\n\`\`\`suggestion\n${suggestion.correction}`;

    await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: payload.pull_request.number,
        body: suggestionBody,
        commit_id: payload.pull_request.head.sha,
        path: suggestion.file,
        line: line,
        ...(startLine ? { start_line: startLine } : {}),
        // position: suggestion.line_start,
        // subject_type: "line",
        start_side: "RIGHT",
        side: "RIGHT",
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
  } catch (exc) {
    console.log(exc);
  }
};

export const applyReview = async ({
  octokit,
  payload,
  review,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["pull_request"];
  review: Review;
}) => {
  let commentPromise = null;
  const comment = review.review?.comment;
  if (comment != null) {
    commentPromise = postGeneralReviewComment(octokit, payload, comment);
  }
  const suggestionPromises = review.suggestions.map((suggestion) =>
    postInlineComment(octokit, payload, suggestion)
  );
  await Promise.all([
    ...(commentPromise ? [commentPromise] : []),
    ...suggestionPromises,
  ]);
};

const addLineNumbers = (contents: string) => {
  const rawContents = String.raw`${contents}`;
  const prepended = rawContents
    .split("\n")
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join("\n");
  return prepended;
};

export const getGitFile = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"] | WebhookEventMap["pull_request"],
  branch: BranchDetails,
  filepath: string
) => {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        path: filepath,
        ref: branch.name, // specify the branch name here
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    ); //Collect the response and get information about the repo
    //@ts-ignore
    const decodedContent = Buffer.from(
      response.data.content,
      "base64"
    ).toString("utf8");
    //@ts-ignore
    return { content: decodedContent, sha: response.data.sha };
  } catch (exc) {
    if (exc.status === 404) {
      return { content: null, sha: null };
    }
    console.log(exc);
    throw exc;
  }
};

export const getFileContents = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  branch: BranchDetails,
  filepath: string
) => {
  // Attempt to fetch the file
  const gitFile = await getGitFile(
    octokit,
    payload,
    branch,
    processGitFilepath(filepath)
  );

  if (!gitFile.content) {
    return null;
  }

  // If file exists, process it
  const fileWithLines = `# ${filepath}\n${addLineNumbers(gitFile.content)}`;
  return {
    result: fileWithLines,
    functionString: `Opening file: ${filepath}`,
  };
};

export const commentIssue = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"],
  comment: string
) => {
  await octokit.rest.issues.createComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.issue.number,
    body: comment,
  });
};

const parseFileFromFilepath = (path: string) => {
  const segments = path.split("/");
  return segments[segments.length - 1];
};

const findExternalFunctionFromRepo = async (
  import_statements: Set<string>,
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  functionCalls: Set<string>
): Promise<importedFunctions> => {
  const result: importedFunctions = {
    filepath: "",
    filename: "",
    functions: new Set<string>(),
  };
  const { base, head } = payload.pull_request;
  const baseBranch: BranchDetails = {
    name: base.ref,
    sha: base.sha,
    url: payload.pull_request.url,
  };

  //Split the import statement into ["from {filepath}", {filepath}]
  //const pathMatch = import_statement.match(/from ['"]([^'"]+)['"]/);
  //if (!pathMatch) return null; //not an exported function import
  //const importPath = pathMatch[1];

  const filepath = processGitFilepath(importPath); //extract {filepath}
  result.filepath = filepath;
  result.filename = parseFileFromFilepath(filepath); //extract {file in filepath}
  result.functions = new Set<string>(); //Initialize functions Set

  try {
    const file_contents = await getFileContents(
      octokit,
      payload,
      baseBranch,
      filepath
    );

    if (!file_contents) {
      console.log(`No content found for file: ${filepath}`);
      return result;
    }

    //if (import_statement.includes("{")) {
    //} else if (import_statement.includes("*")) {
    //}
  } catch (error) {
    console.log(`Error fetching file ${filepath}:`, error);
  }
  return result;
};

const parseFunctions = (hunk_lines: string[], functionCalls: Set<string>) => {
  const changedLines = hunk_lines
    .filter((line) => line.startsWith("+") || line.startsWith("-"))
    .map((line) => line.slice(1).trim()); // Remove +/- prefix
  //find the direct and method function calls in the changed lines
  changedLines.forEach((line) => {
    const directCalls = line.matchAll(/(\w+)\s*\(/g);
    for (const match of directCalls) {
      functionCalls.add(match[1]);
    }
    const methodCalls = line.matchAll(/(\w+)\.(\w+)\s*\(/g);
    for (const match of methodCalls) {
      functionCalls.add(`${match[1]}.${match[2]}`);
    }
  });
};

//Find the context for a single Hunk
//Use case: For each hunk, applyImportContext()
export const applyImportContext = (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  file: PRFile,
  filenames: Set<string>
): importedFunctions => {
  const functionCalls = new Set<string>();
  const externalFunctions: importedFunctions = {
    filepath: "",
    filename: "",
    functions: functionCalls,
  };
  //find lines in the old contents with imports
  const importLines = file.old_contents
    .split("\n")
    .filter((line) => line.trim().startsWith("import"));
  //Parse the patch into PatchInfo Array, for each PatchInfo extract function calls from the hunk lines
  const patches: PatchInfo[] = diff.parsePatch(file.patch);
  patches.forEach((patch) => {
    patch.hunks.forEach((hunk) => {
      parseFunctions(hunk.lines, functionCalls);
    });
  });
  //Identify external functions and push them to the output
  importLines.forEach(async (import_statement) => {
    await findExternalFunctionFromRepo(
      filenames,
      octokit,
      payload,
      externalFunctions.functions
    );
  });

  return externalFunctions;
};

export const createBranch = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"]
) => {
  let branchDetails = null;
  try {
    const title = payload.issue.title.replace(/\s/g, "-").substring(0, 15);

    const hash = Math.random().toString(36).substring(2, 7);
    const subName = `${title}-${hash}`.substring(0, 20);
    const branchName = `Code-Bot/${subName}`;
    // Get the default branch for the repository
    const { data: repo } = await octokit.rest.repos.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    // Get the commit SHA of the default branch
    const { data: ref } = await octokit.rest.git.getRef({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `heads/${repo.default_branch}`,
    });

    // Create a new branch from the commit SHA
    const { data: newBranch } = await octokit.rest.git.createRef({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });

    console.log(newBranch);

    branchDetails = {
      name: branchName,
      sha: newBranch.object.sha,
      url: newBranch.url,
    };
    let branchUrl = `https://github.com/${payload.repository.owner.login}/${payload.repository.name}/tree/${branchName}`;
    const branchComment = `Branch created: [${branchName}](${branchUrl})`;
    await commentIssue(octokit, payload, branchComment);

    console.log(`Branch ${branchName} created`);
  } catch (exc) {
    console.log(exc);
  }
  return branchDetails;
};
