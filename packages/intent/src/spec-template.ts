export function generateSpecTemplate(title = "New Feature", overview = "Describe your feature goal here"): string {
  return `---
title: ${title}
version: 1
status: draft
author: developer
created_at: ${new Date().toISOString()}
---

# ${title}

## Overview
${overview}

## Implementation Plan
1. Research existing codebase and identify files to modify.
2. Implement core business logic and interfaces.
3. Add unit and integration tests verifying all edge cases.
4. Verify tests pass without altering existing test assertions.

## Acceptance Criteria
- [ ] AC-1: Core functionality is implemented and exported.
- [ ] AC-2: Edge cases and error handling return appropriate error messages.
- [ ] AC-3: Automated test suite passes with zero failures.
- [ ] AC-4: Existing tests remain intact and unmodified.
`;
}

