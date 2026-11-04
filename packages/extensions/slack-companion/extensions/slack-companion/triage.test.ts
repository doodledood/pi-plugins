// Holds docs/adr/20261104-let-the-agent-carry-slack-conversations-on-by-itself.md: the cheap
// check reads its model's answer strictly, and runs on the cheapest priced model by default.
import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { chooseTriageModel, triageContext, triageInput, triageVerdict } from "./triage.ts";

const reply = (text: string) => ({ content: [{ type: "text", text }] }) as unknown as AssistantMessage;

function model(provider: string, id: string, input: number, output: number): Model<Api> {
  return { provider, id, cost: { input, output, cacheRead: 0, cacheWrite: 0 }, input: ["text"] } as unknown as Model<Api>;
}

test("only an answer that starts with YES speaks", () => {
  for (const yes of ["YES", "YES.", "  yes, because they asked", "**Yes**"]) assert.equal(triageVerdict(reply(yes)), true, yes);
  for (const no of ["NO", "No.", "maybe yes", "I would say YES", "", "yesterday"]) assert.equal(triageVerdict(reply(no)), false, no);
});

test("the default is the cheapest priced text model of the session's provider; a configured one wins; a missing one falls back with a note", () => {
  const session = model("p", "big", 15, 75);
  const available = [model("p", "a", 3, 15), model("p", "b", 1, 5), model("q", "c", 0.1, 0.4), model("p", "free", 0, 0), session];
  assert.equal(chooseTriageModel(undefined, session, available).model.id, "b");
  assert.deepEqual(chooseTriageModel("p/a", session, available), { model: available[0] });
  const missing = chooseTriageModel("x/y", session, available);
  assert.equal(missing.model, session);
  assert.match(missing.note!, /x\/y is not available/);
  const unpriced = chooseTriageModel(undefined, model("r", "only", 0, 0), [model("r", "only", 0, 0)]);
  assert.match(unpriced.note!, /no priced model/);
});

test("the check sees the agent's own messages, earlier ones and the batch, and whether the agent was addressed", () => {
  const m = (ts: string, text: string, userName = "Robin Colleague") => ({ ts, userId: "U1", userName, text, agentFooter: false });
  const input = triageInput({
    label: "Robin Colleague (DM)", ownerName: "Dana Owner", addressed: true,
    context: [m("1.1", "which env?", "Dana Owner"), m("1.2", "earlier chat"), m("1.3", "staging")],
    ownPosts: new Set(["1.1"]),
    batch: [m("1.3", "staging")],
  });
  assert.deepEqual(input.agentMessages.map((x) => x.text), ["which env?"]);
  assert.deepEqual(input.recent.map((x) => x.text), ["earlier chat"]);
  const user = String(triageContext(input).messages[0]!.content);
  assert.match(user, /direct message or the agent was mentioned/);
  assert.match(user, /The agent's recent messages here:\n- Dana Owner: which env\?/);
  assert.match(user, /New messages:\n- Robin Colleague: staging/);
});
