import {
  BranchDetails,
  BuilderResponse,
  CodeSuggestion,
  Review,
  processGitFilepath,
  importedFunctions,
  PRFile,
} from "./constants";
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";

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
    );//Collect the response and get information about the repo
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
  const gitFile = await getGitFile(
    octokit,
    payload,
    branch,
    processGitFilepath(filepath)
  );
  const fileWithLines = `# ${filepath}\n${addLineNumbers(gitFile.content)}`;
  return { result: fileWithLines, functionString: `Opening file: ${filepath}` };
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

// Helper to parse specific named functions from file content
const parseNamedFunctions = (
  content: string,
  functionNames: string[]
): Set<string> => {
  const functions = new Set<string>();
  const exportRegex = /export\s+(const|function|class|let|var)\s+(\w+)/g;
  let match;

  while ((match = exportRegex.exec(content)) !== null) {
    const exportedName = match[2];
    if (functionNames.includes(exportedName)) {
      functions.add(exportedName);
    }
  }
  return functions;
};

// Helper to parse all exported functions from file content
const parseAllExportedFunctions = (content: string): Set<string> => {
  const functions = new Set<string>();
  const exportRegex = /export\s+(const|function|class|let|var)\s+(\w+)/g;
  let match;

  while ((match = exportRegex.exec(content)) !== null) {
    functions.add(match[2]);
  }
  return functions;
};

// Helper to extract function names from import statement
const extractFunctionNames = (importStatement: string): string[] => {
  const match = importStatement.match(/{([^}]+)}/);
  if (!match) return [];

  return match[1].split(",").map((func) => func.trim().split(" as ")[0]); // Handle potential aliases
};

const findExternalFunctionFromRepo = async (
  import_statement: string,
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"]
): Promise<importedFunctions> => {
  const result: importedFunctions = {
    filepath: "",
    filename: "",
    functions: new Set<string>(),
  };

  //Split the import statement into ["from {filepath}", {filepath}]
  const pathMatch = import_statement.match(/from ['"]([^'"]+)['"]/);
  if (!pathMatch) return null; //not an exported function import
  const importPath = pathMatch[1];

  //Check if the import statement is a package import
  if (
    !importPath.startsWith(".") &&
    !importPath.startsWith("/") &&
    !importPath.startsWith("@/")
  )
    return null;

  const filepath = processGitFilepath(importPath); //extract {filepath}
  result.filepath = filepath;
  result.filename = parseFileFromFilepath(filepath); //extract {file in filepath}
  result.functions = new Set<string>(); //Initialize functions Set


    const file_contents = await getFileContents(
      octokit,
      payload,
      branch,
      filepath
    );

    if (!file_contents) {
      console.log(`No content found for file: ${filepath}`);
      return result;
    }

    if (import_statement.includes("{") && import_statement.includes("}")) {
      
    } else if (import_statement.includes("*")) {
      
    }
  } catch (error) {
    console.log(`Error fetching file ${filepath}:`, error);
  }
  return result;
};

const findRepoImport = (
  importLines: string[],
  functionCalls: string[]
): string[] => {
  const statements: string[] = [];
  functionCalls.forEach((func) => {
    for (const line of importLines) {
      if (line.includes(func)) {
        statements.push(line.trim());
      }
    }
  });
  return statements;
};

const fetchExternalFunctionFiles = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  externalFuncs: importedFunctions[]
) => {
  const branch: BranchDetails = {
    name: payload.pull_request.base.ref,
    sha: payload.pull_request.base.sha,
    url: payload.pull_request.url,
  };

  const fileContents = await Promise.all(
    externalFuncs.map(async (func) => {
      const file = await getGitFile(octokit, payload, branch, func.filepath);
      return {
        ...func,
        content: file.content,
      };
    })
  );
  return fileContents;
};

//Find the context for a single Hunk
//Use case: For each hunk, applyImportContext()
const applyImportContext = (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  file: PRFile
): importedFunctions[] => {
  const externalFunctions: importedFunctions[] = [];

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
    );

  // Parse the patch to get hunks
  const patches = diff.parsePatch(file.patch);
  patches.forEach((patch) => {
    patch.hunks.forEach((hunk) => {
      //find changed lines
      const changedLines = hunk.lines
        .filter((line) => line.startsWith("+") || line.startsWith("-"))
        .map((line) => line.slice(1).trim()); // Remove +/- prefix

      //find the direct and method function calls in the changed lines
      const functionCalls = new Set<string>();
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

      if (file.current_contents) {
        //find all imported functions
        const importLines = file.current_contents
          .split("\n")
          .filter((line) => line.trim().startsWith("import"));

        //find all imported statements from the repo
        const repo_imports = findRepoImport(
          importLines,
          Array.from(functionCalls)
        );

        //Identify external functions and push them to the output
        repo_imports.forEach(async (import_statement) => {
          externalFunctions.push(
            await findExternalFunctionFromRepo(
              import_statement,
              octokit,
              payload
            )
          );
        });
      } else {
        console.log("No contents in this file!");
      }
    });
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
