const INVOCATION_RE = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

export function parseInvocation(message: string): { skillName: string; argsString: string; positionalArgs: string[] } | null {
  const match = message.match(INVOCATION_RE);
  if (!match) return null;
  const skillName = match[1];
  const argsString = match[2] ?? '';
  const positionalArgs = argsString ? argsString.split(/\s+/) : [];
  return { skillName, argsString, positionalArgs };
}

export function substituteArgs(content: string, argsString: string, positionalArgs: string[]): string {
  // Split content into fenced and non-fenced regions
  const parts: { text: string; isCode: boolean }[] = [];
  let remaining = content;
  let isCode = false;

  while (remaining.length > 0) {
    const fenceIdx = remaining.indexOf('```');
    if (fenceIdx === -1) {
      parts.push({ text: remaining, isCode });
      break;
    }
    if (fenceIdx > 0) parts.push({ text: remaining.slice(0, fenceIdx), isCode });
    const afterFence = remaining.slice(fenceIdx + 3);
    parts.push({ text: '```', isCode: false }); // keep the fence markers
    remaining = afterFence;
    isCode = !isCode;
  }

  return parts.map(part => {
    if (part.isCode) return part.text;
    let text = part.text;
    text = text.replace(/\$ARGUMENTS/g, argsString);
    text = text.replace(/\$(\d+)/g, (_, n) => {
      const idx = parseInt(n, 10) - 1;
      return idx >= 0 && idx < positionalArgs.length ? positionalArgs[idx] : '';
    });
    return text;
  }).join('');
}
