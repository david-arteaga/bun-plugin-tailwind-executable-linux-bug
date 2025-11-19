import { init, parse } from 'es-module-lexer';
import { existsSync } from 'fs';
import path from 'path';

export async function fixDuplicateExportsInDirectory(dir: string) {
  console.log(`Scanning for .js files in: ${dir}`);

  const jsFiles = await getAllJsFiles(dir);
  console.log(`Found ${jsFiles.length} .js files`);

  if (jsFiles.length === 0) {
    console.log('No .js files found');
    return;
  }

  // Process all files in parallel
  const results = await Promise.all(
    jsFiles.map(async (filePath) => {
      try {
        const wasFixed = await fixDuplicateExportsInFile(filePath);
        return { filePath, wasFixed, error: null };
      } catch (error) {
        return { filePath, wasFixed: false, error };
      }
    })
  );

  // Report results
  const fixed = results.filter((r) => r.wasFixed);
  const errors = results.filter((r) => r.error);

  console.log(`\nResults:`);
  console.log(`- Total files: ${jsFiles.length}`);
  console.log(`- Files fixed: ${fixed.length}`);
  console.log(`- Errors: ${errors.length}`);

  if (fixed.length > 0) {
    console.log('\nFixed files:');
    fixed.forEach(({ filePath }) => {
      console.log(`  - ${filePath}`);
    });
  }

  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(({ filePath, error }) => {
      console.log(`  - ${filePath}: ${error}`);
    });
  }
}

async function fixDuplicateExportsInFile(filePath: string): Promise<boolean> {
  await init;
  const originalCode = await Bun.file(filePath).text();
  const [imports, exports] = parse(originalCode);

  // Build a structure of export statements with their boundaries and the names they export
  type ExportStatement = {
    start: number; // Position of 'export' keyword
    end: number; // Position after closing '}'
    names: string[];
  };

  const exportStatements: ExportStatement[] = [];

  // For each export name, find its containing export statement
  for (const exp of exports) {
    if (!exp.n) continue; // Skip non-named exports

    const exportNameStart = exp.s;

    // Search backwards from the export name to find 'export {'
    let searchStart = exportNameStart;
    let exportKeywordPos = -1;
    let openBracePos = -1;

    // Find the 'export' keyword before this export name
    while (searchStart > 0) {
      searchStart--;
      if (
        originalCode.slice(searchStart, searchStart + 6) === 'export' &&
        (searchStart === 0 || /\s/.test(originalCode[searchStart - 1]))
      ) {
        exportKeywordPos = searchStart;
        // Now find the opening brace after 'export'
        for (let i = searchStart + 6; i < exportNameStart; i++) {
          if (originalCode[i] === '{') {
            openBracePos = i;
            break;
          }
        }
        if (openBracePos !== -1) break;
      }
    }

    if (exportKeywordPos === -1 || openBracePos === -1) continue;

    // Search forwards from the export name to find the closing '}'
    let closeBracePos = -1;
    let braceDepth = 0;
    for (let i = openBracePos; i < originalCode.length; i++) {
      if (originalCode[i] === '{') braceDepth++;
      else if (originalCode[i] === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          closeBracePos = i;
          break;
        }
      }
    }

    if (closeBracePos === -1) continue;

    const statementEnd = closeBracePos + 1;

    // Check if we already have this statement
    const existing = exportStatements.find(
      (stmt) => stmt.start === exportKeywordPos && stmt.end === statementEnd
    );

    if (existing) {
      // Add this export name to the existing statement
      if (!existing.names.includes(exp.n)) {
        existing.names.push(exp.n);
      }
    } else {
      // Create a new statement entry
      exportStatements.push({
        start: exportKeywordPos,
        end: statementEnd,
        names: [exp.n],
      });
    }
  }

  // Sort statements by position (earliest first)
  exportStatements.sort((a, b) => a.start - b.start);

  // Identify what to fix
  const seen = new Set<string>();
  const statementsToRemove: Array<{ start: number; end: number }> = [];
  const namesToRemoveFromStatements = new Map<ExportStatement, Set<string>>();

  for (const stmt of exportStatements) {
    const duplicateNames = stmt.names.filter((name) => seen.has(name));
    const newNames = stmt.names.filter((name) => !seen.has(name));

    if (duplicateNames.length > 0) {
      if (newNames.length === 0) {
        // ALL names are duplicates - remove the entire statement
        let removalEnd = stmt.end;

        // Also remove trailing newline and semicolon if present
        while (removalEnd < originalCode.length) {
          const char = originalCode[removalEnd];
          if (char === ';') {
            removalEnd++;
          } else if (char === '\n' || char === '\r') {
            removalEnd++;
            // Only consume one newline
            if (
              char === '\r' &&
              removalEnd < originalCode.length &&
              originalCode[removalEnd] === '\n'
            ) {
              removalEnd++;
            }
            break;
          } else if (char === ' ' || char === '\t') {
            removalEnd++;
          } else {
            break;
          }
        }

        statementsToRemove.push({ start: stmt.start, end: removalEnd });
      } else {
        // SOME names are duplicates - need to remove just the duplicate names
        namesToRemoveFromStatements.set(stmt, new Set(duplicateNames));
        // Mark the new names as seen
        newNames.forEach((name) => seen.add(name));
      }
    } else {
      // No duplicates in this statement - mark all as seen
      stmt.names.forEach((name) => seen.add(name));
    }
  }

  // If nothing to fix, return false
  if (
    statementsToRemove.length === 0 &&
    namesToRemoveFromStatements.size === 0
  ) {
    return false;
  }

  let result = originalCode;

  // First, handle removing individual names from statements (do this first, before positions change)
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  for (const [stmt, namesToRemove] of namesToRemoveFromStatements) {
    // Find the positions of each export name within the statement
    const stmtText = originalCode.slice(stmt.start, stmt.end);
    const openBracePos = stmtText.indexOf('{');
    const closeBracePos = stmtText.lastIndexOf('}');

    if (openBracePos === -1 || closeBracePos === -1) continue;

    // Get the content between braces
    const contentStart = stmt.start + openBracePos + 1;
    const contentEnd = stmt.start + closeBracePos;
    const content = originalCode.slice(contentStart, contentEnd);

    // Parse the export names and their positions
    // Split by comma, keeping track of positions
    const parts: Array<{ name: string; start: number; end: number }> = [];
    let currentPos = 0;

    const segments = content.split(',');
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const trimmedName = segment.trim();

      if (trimmedName) {
        const nameStartInSegment = segment.indexOf(trimmedName);
        parts.push({
          name: trimmedName,
          start: contentStart + currentPos + nameStartInSegment,
          end:
            contentStart + currentPos + nameStartInSegment + trimmedName.length,
        });
      }

      currentPos += segment.length + 1; // +1 for the comma
    }

    // Keep only the names we want to keep
    const namesToKeep = parts.filter((part) => !namesToRemove.has(part.name));

    if (namesToKeep.length > 0) {
      // Rebuild the export statement with only the names to keep
      const newNames = namesToKeep.map((p) => p.name).join(', ');
      const newContent = `export { ${newNames} }`;

      edits.push({
        start: stmt.start,
        end: stmt.end,
        replacement: newContent,
      });
    }
  }

  // Apply edits for partial removals (in reverse order to maintain positions)
  for (const edit of edits.reverse()) {
    result =
      result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  // Then remove entire statements (in reverse order to maintain positions)
  for (const { start, end } of statementsToRemove.reverse()) {
    result = result.slice(0, start) + result.slice(end);
  }

  // Write the fixed content back to the file
  await Bun.write(filePath, result);

  // Show diff for debugging
  //   await showDiff({
  //     filePath,
  //     originalContent: originalCode,
  //     newContent: result,
  //   });

  return true;
}

async function showDiff({
  filePath,
  originalContent,
  newContent,
}: {
  filePath: string;
  originalContent: string;
  newContent: string;
}) {
  const tmpDir = path.join(process.cwd(), 'tmp');
  const tmpOriginal = path.join(tmpDir, `${path.basename(filePath)}.original`);
  const tmpNew = path.join(tmpDir, `${path.basename(filePath)}.new`);

  try {
    // Create tmp directory if it doesn't exist
    await Bun.$`mkdir -p ${tmpDir}`.quiet();

    // Write temp files
    await Bun.write(tmpOriginal, originalContent);
    await Bun.write(tmpNew, newContent);

    // Try to use git diff for colored output, fallback to regular diff
    const diffResult =
      await Bun.$`git diff --no-index --color=always ${tmpOriginal} ${tmpNew}`
        .nothrow()
        .quiet();

    console.log(`\n🔧 Fixed duplicate exports in: ${filePath}`);
    console.log('━'.repeat(80));

    if (diffResult.exitCode === 0 || diffResult.exitCode === 1) {
      // Exit code 1 means files differ (which is expected)
      console.log(diffResult.stdout.toString());
    } else {
      // Fallback to regular diff if git diff fails
      const fallbackDiff = await Bun.$`diff -u ${tmpOriginal} ${tmpNew}`
        .nothrow()
        .quiet();
      console.log(fallbackDiff.stdout.toString());
    }

    console.log('━'.repeat(80));
  } finally {
    // Clean up temp files
    await Bun.$`rm -f ${tmpOriginal} ${tmpNew}`.nothrow().quiet();
  }
}

async function getAllJsFiles(dir: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.js');
  const files = await Array.fromAsync(glob.scan({ cwd: dir }));
  return files.map((file) => path.join(dir, file));
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: bun fix-js-duplicate-exports.ts <directory>');
    process.exit(1);
  }

  if (!existsSync(dir)) {
    console.error(`Error: Directory does not exist: ${dir}`);
    process.exit(1);
  }

  await fixDuplicateExportsInDirectory(dir);
}

if (import.meta.main) {
  await main();
}
