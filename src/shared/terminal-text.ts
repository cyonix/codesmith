export function escapeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) return character;
      if (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        codePoint === 0x061c ||
        codePoint === 0x200e ||
        codePoint === 0x200f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      ) {
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
      }
      return character;
    })
    .join("");
}
