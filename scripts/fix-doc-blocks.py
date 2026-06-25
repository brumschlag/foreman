#!/usr/bin/env python3
"""Fix markdown lint issues in PRD and TRD docs."""

import re

# Prefix-based fence language detection for the line following a bare ```.
# Order matters: the first matching entry wins (mirrors the original if/elif).
_NEXT_LINE_LANG = (
    (("src/", "1.", "4."), "```text"),
    (("//", "interface ", "async function"), "```typescript"),
    (("POST", "GET"), "```http"),
    (("foreman",), "```bash"),
    (("#",), "```bash"),
)


def _detect_fence_language(next_line, prev_line):
    """Return the replacement fence for a bare ```, or None to leave it unchanged."""
    for prefixes, fence in _NEXT_LINE_LANG:
        if next_line.startswith(prefixes):
            return fence
    if prev_line.strip().endswith('Schema:'):
        return '```typescript'
    if prev_line.strip().endswith('Workflow:'):
        return '```text'
    return None


def fix_fenced_blocks(filepath):
    with open(filepath, 'r') as f:
        lines = f.read().split('\n')

    fixed = []
    for i, line in enumerate(lines):
        next_line = lines[i + 1] if i + 1 < len(lines) else ''
        prev_line = lines[i - 1] if i > 0 else ''

        # Fix empty code block markers with text-based content
        if line == '```' and 0 < i < len(lines) - 1:
            fence = _detect_fence_language(next_line, prev_line)
            if fence:
                line = fence

        # Fix yaml blocks
        if line == '```' and 'apiUrl' in next_line:
            line = '```yaml'

        fixed.append(line)

    return '\n'.join(fixed)

# Fix PRD
content = fix_fenced_blocks('docs/PRD/PRD-2026-013-jira-issue-monitor.md')
with open('docs/PRD/PRD-2026-013-jira-issue-monitor.md', 'w') as f:
    f.write(content)

# Fix TRD - simpler, just add text to diagram blocks
with open('docs/TRD/TRD-2026-013-jira-issue-monitor.md', 'r') as f:
    trd_content = f.read()

# Add text identifier to ASCII diagrams and data flow blocks
trd_content = re.sub(
    r'^(```\n┌─)',
    r'```text\n┌─',
    trd_content,
    flags=re.MULTILINE
)
trd_content = re.sub(
    r'^(```\nEvery pollInterval)',
    r'```text\nEvery pollInterval',
    trd_content,
    flags=re.MULTILINE
)
trd_content = re.sub(
    r'^(```\nJira sends)',
    r'```text\nJira sends',
    trd_content,
    flags=re.MULTILINE
)
trd_content = re.sub(
    r'^(```\nJiraTriggerHandler)',
    r'```text\nJiraTriggerHandler',
    trd_content,
    flags=re.MULTILINE
)
trd_content = re.sub(
    r'^(```\nsrc/daemon)',
    r'```text\nsrc/daemon',
    trd_content,
    flags=re.MULTILINE
)

# Add bash to CLI examples
trd_content = re.sub(
    r'^(```\nforeman)',
    r'```bash\nforeman',
    trd_content,
    flags=re.MULTILINE
)

# Add http to HTTP examples
trd_content = re.sub(
    r'^(```\nPOST /)',
    r'```http\nPOST /',
    trd_content,
    flags=re.MULTILINE
)

with open('docs/TRD/TRD-2026-013-jira-issue-monitor.md', 'w') as f:
    f.write(trd_content)

print('Done fixing code blocks')
