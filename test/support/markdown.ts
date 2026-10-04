export interface MarkdownLink {
  readonly target: string;
  readonly anchor?: string;
}

const FENCE = /^(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LINK = /\]\(([^)\s]+)\)/g;
const SCRIPT = /\bbun run ([a-z][a-z0-9:-]*)/g;

function unfencedLines(markdown: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line.trim())) {
      fenced = !fenced;
    } else if (!fenced) {
      lines.push(line);
    }
  }
  return lines;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

export function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of unfencedLines(markdown)) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const base = slugify(heading[2]!);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      slugs.add(count === 0 ? base : `${base}-${count}`);
    }
  }
  return slugs;
}

export function relativeLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const line of unfencedLines(markdown)) {
    for (const match of line.matchAll(LINK)) {
      const href = match[1]!;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const [target = '', anchor] = href.split('#');
        links.push({
          target,
          ...(anchor === undefined
            ? {}
            : { anchor: decodeURIComponent(anchor) }),
        });
      }
    }
  }
  return links;
}

export function scriptsRun(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(SCRIPT)].map((match) => match[1]!))];
}
