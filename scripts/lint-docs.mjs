import { glob } from "node:fs/promises";
import { lint } from "markdownlint/promise";

const files = [];
for await (const file of glob(["*.md", "docs/**/*.md", ".github/**/*.md"])) {
  files.push(file);
}
files.sort();
if (!files.length) throw new Error("No project Markdown files found");
const results = await lint({
  files,
  config: {
    // Keep technical links and tables intact.
    MD013: false,
    // The pull request template starts with a section heading.
    MD041: false,
  },
});
const output = Object.entries(results).flatMap(([file, errors]) =>
  errors.map((error) => `${file}:${error.lineNumber} ${error.ruleNames[0]} ${error.ruleDescription}${error.errorDetail ? `: ${error.errorDetail}` : ""}`),
).join("\n");
if (output) {
  console.error(output);
  process.exitCode = 1;
} else {
  console.log(`Markdown lint passed (${files.length} files)`);
}
