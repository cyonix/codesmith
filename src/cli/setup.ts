import { stdin, stdout } from "node:process";
import { CodeSmithError } from "../shared/errors.js";
import { modelCatalogGroups, type ModelCatalogEntry } from "../providers/model-catalog.js";

export type Question = (prompt: string) => Promise<string>;
export type Write = (output: string) => void;

export async function selectModel(question: Question, write: Write): Promise<ModelCatalogEntry> {
  write("Select a model:\n");

  const displayedEntries: ModelCatalogEntry[] = [];
  let index = 0;

  for (const [provider, entries] of modelCatalogGroups()) {
    write(`\n${provider}\n`);
    for (const entry of entries) {
      index += 1;
      displayedEntries.push(entry);
      write(`  ${index}. ${entry.name} (${entry.model}; ${entry.tier})\n`);
    }
  }

  while (true) {
    const input = await question("\nModel number: ");
    if (/^\d+$/.test(input.trim())) {
      const selected = displayedEntries[Number(input.trim()) - 1];
      if (selected) return selected;
    }
    write("Enter a valid model number.\n");
  }
}

export async function promptForApiKey(write: Write = (output) => stdout.write(output)): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new CodeSmithError("configuration", "An interactive TTY is required to enter an API key.");
  }

  while (true) {
    const apiKey = await readMaskedLine("API key: ", write);
    if (apiKey.trim()) return apiKey.trim();
    write("An API key is required.\n");
  }
}

async function readMaskedLine(prompt: string, write: Write): Promise<string> {
  write(prompt);

  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const finish = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      write("\n");
    };

    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish();
          reject(new CodeSmithError("configuration", "API key entry was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}
