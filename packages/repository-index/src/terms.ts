import type { IndexedFile } from "./types";
const stop = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "where",
  "are",
  "code",
  "related",
  "file",
  "files",
  "src",
  "ts",
  "js",
  "tsx",
  "jsx",
  "index",
]);
export function termsOf(value: string): string[] {
  const words =
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9_$]{2,80}/g) ?? [];
  return [
    ...new Set(
      words
        .filter((word) => !stop.has(word))
        .map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word)),
    ),
  ].slice(0, 80);
}
export function fileTerms(file: IndexedFile): { term: string; weight: number }[] {
  const terms = new Map<string, number>([[file.path.toLowerCase(), 24]]);
  const add = (text: string, weight: number) => {
    for (const term of termsOf(text)) terms.set(term, Math.max(terms.get(term) ?? 0, weight));
  };
  add(file.path, 8);
  for (const symbol of file.symbols) {
    add(symbol.name, 12);
    terms.set(symbol.name.toLowerCase().slice(0, 200), 16);
  }
  for (const name of file.exports) add(name, 10);
  for (const name of file.imports) add(name, 6);
  add(file.summary, 2);
  file.concepts.forEach((concept) => add(concept, 4));
  return [...terms]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 600)
    .map(([term, weight]) => ({ term, weight }));
}
