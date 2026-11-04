import assert from "node:assert/strict";
import test from "node:test";
import { parseSlackLink } from "./conversation.ts";
import { compareTs, parseChannelListing, parseLookup, parseProfile, parseSendResult, parseThreadListing, SlackFormatError, tsFromMillis } from "./format.ts";

// Captured from the official Slack MCP server through a company gateway (which redacts emails),
// then scrubbed: names, ids and text are invented; the layout is byte-for-byte the server's.
const CHANNEL_GATEWAY = JSON.stringify({
  messages: "Channel: DM (D0FAKE0001)\n\n=== Message from Robin Colleague <[EMAIL:redacted]> (U0COLL0001) at 2026-11-04 11:35:56 IST === \nMessage TS: 1793784956.232429\n1. agree.\n2. not sure I understand the question.\nThread: 2 replies (latest: 2026-11-04 11:39:53 IST)",
  pagination_info: "There are more messages available. To view the next page, use cursor: `bmV4dF90czoxNzkzNzg0NTMyNjk1Mzg5`\n",
});
// The official server's own documented shape: the email is present.
const CHANNEL_OFFICIAL = CHANNEL_GATEWAY.replace("[EMAIL:redacted]", "robin@example.com");

const THREAD = JSON.stringify({
  messages: "=== THREAD PARENT MESSAGE ===\nFrom: Dana Owner <[EMAIL:redacted]> (U0OWNER001)\nTime: 2026-11-03 15:22:23 IST\nMessage TS: 1793712143.358799\nThree things so I build the right thing:\n1. first\n*Sent using* <@A0FAKEAPP|Slack MCP>\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Robin Colleague <[EMAIL:redacted]> (U0COLL0001)\nTime: 2026-11-03 16:16:34 IST\nMessage TS: 1793715394.603439\nNot sure how it can know but I like the direction\n",
  pagination_info: "There are more messages in this thread. To view the next page, use cursor: `bmV4dF90czoxNzkzNzE1MTY1MTE2ODA5`\n",
});

const LOOKUP_OF_REPLY = JSON.stringify({
  messages: "=== THREAD PARENT MESSAGE ===\nFrom: Robin Colleague <[EMAIL:redacted]> (U0COLL0001)\nTime: 2026-11-03 16:16:34 IST\nMessage TS: 1793715394.603439\nNot sure how it can know but I like the direction\n\nNo thread messsages\n",
  pagination_info: "There are no more messages in this thread.\n",
});

const PROFILE = JSON.stringify({ result: "User ID: U0OWNER001\nUsername: dana.owner\nDisplay Name: Dana Owner\nReal Name: Dana Owner\nPronouns: \nTitle: Engineer\nEmail: [EMAIL:****]\nStatus:  \nTimezone: Europe/Berlin\n" });
const SENT = JSON.stringify({ message_link: "https://example.slack.com/archives/D0FAKE0001/p1793710422126239", message_context: { message_ts: "1793710422.126239", channel_id: "D0FAKE0001" } });

for (const [variant, text] of [["gateway", CHANNEL_GATEWAY], ["official", CHANNEL_OFFICIAL]] as const) {
  test(`channel listing (${variant} format) yields ids, authors, text without the thread line, and the next cursor`, () => {
    const listing = parseChannelListing(text);
    assert.equal(listing.messages.length, 1);
    const [m] = listing.messages;
    assert.equal(m!.ts, "1793784956.232429");
    assert.equal(m!.userId, "U0COLL0001");
    assert.equal(m!.userName, "Robin Colleague");
    assert.equal(m!.text, "1. agree.\n2. not sure I understand the question.");
    assert.equal(listing.nextCursor, "bmV4dF90czoxNzkzNzg0NTMyNjk1Mzg5");
  });
}

test("thread listing yields the parent and replies, and strips the MCP footer", () => {
  const listing = parseThreadListing(THREAD);
  assert.equal(listing.parent?.ts, "1793712143.358799");
  assert.equal(listing.parent?.agentFooter, true);
  assert.equal(listing.parent?.text, "Three things so I build the right thing:\n1. first");
  assert.equal(listing.messages.length, 1);
  assert.equal(listing.messages[0]!.userId, "U0COLL0001");
  assert.equal(listing.messages[0]!.agentFooter, false);
  assert.ok(listing.nextCursor);
});

test("a lookup returns the message looked up, its text ending at the server's trailer", () => {
  assert.deepEqual(parseLookup(LOOKUP_OF_REPLY), { ts: "1793715394.603439", userId: "U0COLL0001", userName: "Robin Colleague", text: "Not sure how it can know but I like the direction", agentFooter: false });
  const withReplies = parseLookup(THREAD);
  assert.equal(withReplies.text, "Three things so I build the right thing:\n1. first");
  assert.equal(withReplies.agentFooter, true);
});

test("profile and send results parse; garbage fails loudly", () => {
  assert.deepEqual(parseProfile(PROFILE), { userId: "U0OWNER001", name: "Dana Owner" });
  assert.deepEqual(parseSendResult(SENT), { channelId: "D0FAKE0001", ts: "1793710422.126239" });
  assert.throws(() => parseChannelListing("not json"), SlackFormatError);
  assert.throws(() => parseChannelListing(JSON.stringify({ error: "ratelimited" })), /ratelimited/);
  assert.throws(() => parseLookup(JSON.stringify({ messages: "something else" })), SlackFormatError);
  assert.throws(() => parseSendResult(JSON.stringify({ ok: false })), SlackFormatError);
});

test("timestamps compare numerically and convert from milliseconds", () => {
  assert.equal(compareTs("1793715394.603439", "1793715394.603440"), -1);
  assert.equal(compareTs("999999999.999999", "1000000000.000000"), -1);
  assert.equal(compareTs("1793715394.6", "1793715394.600000"), 0);
  assert.equal(tsFromMillis(1_793_715_394_603), "1793715394.603000");
});

test("Slack links parse into channel, message and thread", () => {
  assert.deepEqual(parseSlackLink("https://ws.slack.com/archives/D0FAKE0001/p1793712143358799"), { channelId: "D0FAKE0001", messageTs: "1793712143.358799" });
  assert.deepEqual(
    parseSlackLink("https://ws.slack.com/archives/C0FAKE0002/p1793712151274699?thread_ts=1793712143.358799&cid=C0FAKE0002"),
    { channelId: "C0FAKE0002", messageTs: "1793712151.274699", threadTs: "1793712143.358799" },
  );
  assert.equal(parseSlackLink("https://evil.example.com/archives/C1/p1793712143358799"), undefined);
  assert.equal(parseSlackLink("not a link"), undefined);
});
