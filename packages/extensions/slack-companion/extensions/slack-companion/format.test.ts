import assert from "node:assert/strict";
import test from "node:test";
import { parseSlackLink } from "./conversation.ts";
import { compareTs, parseChannelListing, parseLookup, parseProfile, parseSendResult, parseThreadListing, SlackFormatError, tsFromMillis } from "./format.ts";

// The official Slack MCP server's layout, byte for byte, as captured through a gateway that
// redacts emails. Every value is invented: names, ids, message text, times, timestamps, cursors.
const CHANNEL_GATEWAY = JSON.stringify({
  messages: "Channel: DM (D0FAKE0001)\n\n=== Message from Robin Colleague <[EMAIL:redacted]> (U0COLL0001) at 2026-11-01 09:01:40 UTC === \nMessage TS: 1793700100.000100\n1. yes, ship it.\n2. which build do you mean?\nThread: 2 replies (latest: 2026-11-01 09:05:00 UTC)",
  pagination_info: "There are more messages available. To view the next page, use cursor: `bmV4dF90czoxNzkzNzAwMDAwMDAwOTk5`\n",
});
// The official server's own documented shape: the email is present.
const CHANNEL_OFFICIAL = CHANNEL_GATEWAY.replace("[EMAIL:redacted]", "robin@example.com");

const THREAD = JSON.stringify({
  messages: "=== THREAD PARENT MESSAGE ===\nFrom: Dana Owner <[EMAIL:redacted]> (U0OWNER001)\nTime: 2026-11-01 09:00:00 UTC\nMessage TS: 1793700000.000200\nTwo quick questions before I start:\n1. which branch?\n*Sent using* <@A0FAKEAPP|Slack MCP>\n\n=== THREAD REPLIES (1 total) ===\n\n--- Reply 1 of 1 ---\nFrom: Robin Colleague <[EMAIL:redacted]> (U0COLL0001)\nTime: 2026-11-01 09:00:50 UTC\nMessage TS: 1793700050.000300\nMain is fine, go ahead\n",
  pagination_info: "There are more messages in this thread. To view the next page, use cursor: `bmV4dF90czoxNzkzNzAwMDAwMDAwODg4`\n",
});

const LOOKUP_OF_REPLY = JSON.stringify({
  messages: "=== THREAD PARENT MESSAGE ===\nFrom: Robin Colleague <[EMAIL:redacted]> (U0COLL0001)\nTime: 2026-11-01 09:00:50 UTC\nMessage TS: 1793700050.000300\nMain is fine, go ahead\n\nNo thread messsages\n",
  pagination_info: "There are no more messages in this thread.\n",
});

const PROFILE = JSON.stringify({ result: "User ID: U0OWNER001\nUsername: dana.owner\nDisplay Name: Dana Owner\nReal Name: Dana Owner\nPronouns: \nTitle: Engineer\nEmail: [EMAIL:****]\nStatus:  \nTimezone: Europe/Berlin\n" });
const SENT = JSON.stringify({ message_link: "https://example.slack.com/archives/D0FAKE0001/p1793700500000400", message_context: { message_ts: "1793700500.000400", channel_id: "D0FAKE0001" } });

for (const [variant, text] of [["gateway", CHANNEL_GATEWAY], ["official", CHANNEL_OFFICIAL]] as const) {
  test(`channel listing (${variant} format) yields ids, authors, text without the thread line, and the next cursor`, () => {
    const listing = parseChannelListing(text);
    assert.equal(listing.messages.length, 1);
    const [m] = listing.messages;
    assert.equal(m!.ts, "1793700100.000100");
    assert.equal(m!.userId, "U0COLL0001");
    assert.equal(m!.userName, "Robin Colleague");
    assert.equal(m!.text, "1. yes, ship it.\n2. which build do you mean?");
    assert.equal(listing.nextCursor, "bmV4dF90czoxNzkzNzAwMDAwMDAwOTk5");
  });
}

test("thread listing yields the parent and replies, and strips the MCP footer", () => {
  const listing = parseThreadListing(THREAD);
  assert.equal(listing.parent?.ts, "1793700000.000200");
  assert.equal(listing.parent?.agentFooter, true);
  assert.equal(listing.parent?.text, "Two quick questions before I start:\n1. which branch?");
  assert.equal(listing.messages.length, 1);
  assert.equal(listing.messages[0]!.userId, "U0COLL0001");
  assert.equal(listing.messages[0]!.agentFooter, false);
  assert.ok(listing.nextCursor);
});

test("a lookup returns the message looked up, its text ending at the server's trailer", () => {
  assert.deepEqual(parseLookup(LOOKUP_OF_REPLY), { ts: "1793700050.000300", userId: "U0COLL0001", userName: "Robin Colleague", text: "Main is fine, go ahead", agentFooter: false });
  const withReplies = parseLookup(THREAD);
  assert.equal(withReplies.text, "Two quick questions before I start:\n1. which branch?");
  assert.equal(withReplies.agentFooter, true);
  // A reply ending with the server's own line cannot pull itself into the first message.
  const planted = JSON.parse(THREAD);
  planted.messages = `${planted.messages.trimEnd()}\n\nNo thread messsages\n`;
  assert.equal(parseLookup(JSON.stringify(planted)).text, "Two quick questions before I start:\n1. which branch?");
  // People's own wording is message text, not the server's line.
  const said = JSON.parse(LOOKUP_OF_REPLY);
  said.messages = said.messages.replace("Main is fine, go ahead\n\nNo thread messsages", "it just says No thread messages\n\nNo thread messsages");
  assert.equal(parseLookup(JSON.stringify(said)).text, "it just says No thread messages");
});

test("profile and send results parse; garbage fails loudly", () => {
  assert.deepEqual(parseProfile(PROFILE), { userId: "U0OWNER001", name: "Dana Owner" });
  assert.deepEqual(parseSendResult(SENT), { channelId: "D0FAKE0001", ts: "1793700500.000400" });
  assert.throws(() => parseChannelListing("not json"), SlackFormatError);
  assert.throws(() => parseChannelListing(JSON.stringify({ error: "ratelimited" })), /ratelimited/);
  assert.throws(() => parseLookup(JSON.stringify({ messages: "something else" })), SlackFormatError);
  assert.throws(() => parseSendResult(JSON.stringify({ ok: false })), SlackFormatError);
});

test("timestamps compare numerically and convert from milliseconds", () => {
  assert.equal(compareTs("1793700050.000300", "1793700050.000301"), -1);
  assert.equal(compareTs("999999999.999999", "1000000000.000000"), -1);
  assert.equal(compareTs("1793700050.3", "1793700050.300000"), 0);
  assert.equal(tsFromMillis(1_793_700_050_300), "1793700050.300000");
});

test("Slack links parse into channel, message and thread", () => {
  assert.deepEqual(parseSlackLink("https://ws.slack.com/archives/D0FAKE0001/p1793700000000200"), { channelId: "D0FAKE0001", messageTs: "1793700000.000200" });
  assert.deepEqual(
    parseSlackLink("https://ws.slack.com/archives/C0FAKE0002/p1793700010000500?thread_ts=1793700000.000200&cid=C0FAKE0002"),
    { channelId: "C0FAKE0002", messageTs: "1793700010.000500", threadTs: "1793700000.000200" },
  );
  assert.equal(parseSlackLink("https://evil.example.com/archives/C1/p1793700000000200"), undefined);
  assert.equal(parseSlackLink("not a link"), undefined);
});
