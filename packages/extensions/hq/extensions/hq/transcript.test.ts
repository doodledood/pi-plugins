import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { dropRoot, makeRoot, writeSessionFile } from "./testing.ts";
import { readTranscript, readTranscriptTail, renderTranscript } from "./transcript.ts";

function entry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-28T12:0${id.length}:00.000Z`,
    message: { role, content: [{ type: "text", text }] },
  });
}

test("a rewound session reads as its live branch, not as every line in the file", async () => {
  const root = await makeRoot("hq-transcript-branch");
  try {
    const path = join(root, "session.jsonl");
    // e1 was abandoned when the user rewound and asked again; e2 is the live answer.
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s1",
          timestamp: "2026-07-28T12:00:00.000Z",
          cwd: "/work",
        }),
        entry("e0", null, "user", "Should we drop the table?"),
        entry("e1", "e0", "assistant", "Yes, drop it."),
        entry("e2", "e0", "assistant", "No, never drop it."),
      ].join("\n"),
      "utf8",
    );

    const messages = await readTranscript(path);
    assert.deepEqual(messages.map((message) => message.text), [
      "Should we drop the table?",
      "No, never drop it.",
    ]);
    assert.equal(
      messages.some((message) => message.text.includes("Yes, drop it")),
      false,
      "an abandoned branch must never be quoted back as what the session said",
    );
  } finally {
    await dropRoot(root);
  }
});

test("a linear session reads in order, oldest first", async () => {
  const root = await makeRoot("hq-transcript-linear");
  try {
    const path = join(root, "session.jsonl");
    await writeSessionFile(path, [
      { role: "user", text: "run the suite" },
      { role: "assistant", text: "it failed on parser.spec.ts" },
    ]);
    const messages = await readTranscript(path);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.match(renderTranscript(messages), /parser\.spec\.ts/);
  } finally {
    await dropRoot(root);
  }
});

test("the tail is budgeted and a missing file is simply empty", async () => {
  const root = await makeRoot("hq-transcript-tail");
  try {
    const path = join(root, "session.jsonl");
    await writeSessionFile(
      path,
      Array.from({ length: 12 }, (_, index) => ({
        role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        text: `message ${index}`,
      })),
    );
    const tail = await readTranscriptTail(path, { maxMessages: 4 });
    assert.equal(tail.length, 4);
    assert.match(tail.at(-1)?.text ?? "", /message 11/);

    assert.deepEqual(await readTranscriptTail(null), []);
    assert.deepEqual(await readTranscriptTail(join(root, "missing.jsonl")), []);
    assert.equal(renderTranscript([]), "(no transcript available)");
  } finally {
    await dropRoot(root);
  }
});

test("a torn final line does not lose the messages before it", async () => {
  const root = await makeRoot("hq-transcript-torn");
  try {
    const path = join(root, "session.jsonl");
    await writeSessionFile(path, [{ role: "user", text: "the question" }]);
    const { readFile } = await import("node:fs/promises");
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"mess`, "utf8");
    const messages = await readTranscript(path);
    assert.deepEqual(messages.map((message) => message.text), ["the question"]);
  } finally {
    await dropRoot(root);
  }
});
