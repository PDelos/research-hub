// A sample external plugin (tests): every rh call is asynchronous across the process boundary.
import { readFileSync } from "node:fs";

export async function activate({ rh }) {
  await rh.agents.registerChatTool("sample_echo", async (args) => `echo ${args.text}`);
  const commands = {
    "sample.env": () => Object.keys(process.env),
    "sample.fetch": async (url) => {
      try {
        return await rh.http.text(url);
      } catch (error) {
        return `refused: ${error.message}`;
      }
    },
    "sample.direct": async () => {
      try {
        await fetch("https://example.com/");
        return "reached";
      } catch {
        return "blocked";
      }
    },
    "sample.readEtc": () => {
      try {
        return readFileSync("/etc/hostname", "utf8");
      } catch (error) {
        return error.code;
      }
    },
    "sample.remember": (text) => rh.files.write("storage", "memo.txt", text),
    "sample.recall": () => rh.files.read("storage", "memo.txt"),
    "sample.crash": () => {
      setTimeout(() => process.exit(3), 20);
      return "bye";
    },
    "sample.hang": () => new Promise(() => {}),
  };
  for (const [id, handler] of Object.entries(commands)) await rh.commands.register(id, handler);
  return {
    sources: {
      sample: {
        name: "sample",
        search: async (q) => [
          {
            source: "sample",
            externalId: "S1",
            ids: { doi: "10.5555/sample.1" },
            title: `Sample paper on ${q.query}`,
            abstract: "Background. We propose a method. It works.",
            authors: ["Sam Ple"],
            publishedAt: new Date().toISOString().slice(0, 10),
            year: new Date().getFullYear(),
          },
        ],
      },
    },
  };
}
