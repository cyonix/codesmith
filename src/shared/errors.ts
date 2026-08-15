export class CodeSmithError extends Error {
  constructor(
    public readonly kind:
      "configuration" | "sandbox" | "arguments" | "command" | "provider" | "loop",
    message: string,
  ) {
    super(message);
    this.name = "CodeSmithError";
  }
}
