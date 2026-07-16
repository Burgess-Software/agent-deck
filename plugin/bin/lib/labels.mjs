// Stream Deck labels are rendered at a fairly large default font size, so
// keep every line deliberately short to avoid OpenDeck clipping the edges.

export function wrapLabel(text, width = 8, maxLines = 2) {
  const value = String(text ?? '').trim();
  if (!value) return '';

  const words = value.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    if (lines.length >= maxLines) break;
    // A single word longer than width must be split before OpenDeck clips it.
    while (cur.length > width && lines.length < maxLines) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const out = lines.slice(0, maxLines);
  if (out.length === maxLines) {
    const used = out.join(' ').length;
    if (used < value.length) out[maxLines - 1] = `${out[maxLines - 1].slice(0, width - 1)}…`;
  }
  return out.join('\n');
}

function oneLine(text, width = 8) {
  const value = String(text ?? '').trim();
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

/**
 * Put the Codex-generated chat title above the project name. Two chat-title
 * lines make same-project threads distinguishable; the last line always
 * identifies their shared project.
 */
export function formatAgentLabel({ title, project }, width = 8) {
  const chat = String(title ?? '').trim();
  const repo = String(project ?? '').trim() || '?';

  // Preserve the roomier legacy layout when no distinct chat name exists.
  if (!chat || chat === repo) return `\n\n${wrapLabel(repo, width, 2)}`;

  return `\n${wrapLabel(chat, width, 2)}\n${oneLine(repo, width)}`;
}
