/**
 * Turn the owner's reply guide (lib/triage/reply-guide.md) into the module the
 * worker imports (lib/triage/reply-guide.generated.ts).
 *
 *   npm run guide
 *
 * The guide is written as Markdown because the owner reads and changes it. The
 * worker reads it as a TypeScript module because that cannot go missing at run
 * time: no file path to get wrong on the host, nothing for a bundler to leave
 * out. A test fails when the two have drifted apart, so an edit to the guide
 * that was not followed by this script never reaches production.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const GUIDE_SOURCE_PATH = join("lib", "triage", "reply-guide.md");
export const GUIDE_MODULE_PATH = join("lib", "triage", "reply-guide.generated.ts");

/** Same text whatever the editor or git made of the line endings. */
export function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** The module's source for a guide's Markdown. */
export function renderGuideModule(markdown: string): string {
  const text = normalizeNewlines(markdown)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return (
    "// GENERATED from reply-guide.md by scripts/build-reply-guide.ts. Do not edit:\n" +
    "// change the Markdown file, then run `npm run guide`.\n\n" +
    `export const REPLY_GUIDE_SOURCE = \`${text}\`;\n`
  );
}

function main() {
  const root = process.cwd();
  const markdown = readFileSync(join(root, GUIDE_SOURCE_PATH), "utf8");
  writeFileSync(join(root, GUIDE_MODULE_PATH), renderGuideModule(markdown), "utf8");
  console.log(`Wrote ${GUIDE_MODULE_PATH} (${normalizeNewlines(markdown).length} characters).`);
}

// Only run when invoked directly, so the functions above can be imported in tests.
if (process.argv[1] && basename(process.argv[1]).startsWith("build-reply-guide")) {
  main();
}
