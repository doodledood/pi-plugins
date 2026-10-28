# ADR: Draw narration in the thinking tone by writing the tone into its Markdown source, checked against pi's renderer

## Status
Accepted

## Area
tool-activity-renderer

## Context
Between tool calls, Claude often writes visible text instead of a thinking block. Some of it is a one-line status; some reads like reasoning ("Relevant sections to touch: … I need to add …"). In one manifest-dev session, 56 assistant messages had text plus a tool call and no thinking block. Pi draws that text at reply brightness, so it sits bright between receded tool rows and gray, italic thinking. That breaks the Graphite rule that brightness carries hierarchy, and users take it for thinking that failed to gray out.

Pi's extension API has no style hook for assistant text. The only hook is a Markdown transformer, whose context gives `messageType`, `isStreaming` and `availableWidth`. It does not say which message the text belongs to or whether that message calls a tool. Pi's own Markdown renderer passes control characters in text through, and its `\[` opens display math, so an escape sequence has to go into the source as it is.

## Decision
The tool activity renderer treats the text of an assistant message that also calls a tool as narration and draws it in the thinking tone (the theme's `thinkingText` color, italic). The text of a message that calls no tool is the reply and stays as it is.

- **Which texts:** the renderer reads `message_update` and `message_end`, plus the branch on `session_start` and `session_tree`, and keys each text by its trimmed content, the same string pi passes to the transformer. Pi gives extensions each update before it redraws, so a text turns quiet as soon as its tool call shows up in the stream. A text that was also a settled reply stays a reply.
- **How:** the transformer writes the tone's escape sequence into the Markdown source at the start of each word. A word that opens with an emphasis delimiter gets it just inside the run, so emphasis still parses. Fenced code, code spans and table delimiter rows are left alone, and inline code is first flattened as thinking does. Pi resets the color after a code span or link and starts every rendered line fresh, which is why the tone goes in once per word and not once per line.
- **Guard:** the result is kept only if pi's own Markdown renderer, with styles stripped, shows exactly the same lines at the drawn width, spaces included. That is checked for the whole text, then block by block. A block that would change keeps the reply color. The worst case is narration drawn as before, never a reply drawn differently.

## Alternatives Considered
- **Change pi upstream** (give the transformer context the message, or add a style hook for assistant text): the clean fix, but it is not in this repo and it blocks on another project. If pi adds such a hook, it should replace the source rewrite.
- **Prompt the model to keep reasoning in thinking:** this cannot be enforced, it fights the model's habit, and narration that is meant as status would still be bright.
- **Tone once per line or per block:** pi resets the foreground after every code span and link and drops the tone at each rendered line, so text fades back to reply brightness partway through a line.
- **Put the tone before each space:** pi carries a space that follows a style change onto the next line when it wraps, so continuation lines would start with a space. A letter-ended sequence before a space also stops `**done:**` from closing.
- **Leave it:** the renderer would stay correct, but the transcript would keep breaking immersion in a way users misread as a bug.

## Consequences

### Positive
- Only the final reply reads at full brightness. Narration, thinking and finished tool rows all sit beneath it in the same tone, live and in restored history.
- The render check is the same kind thinking already uses, so structure (lists, tables, links, math, code) cannot change. At worst a block stays bright.

### Negative
- The transformer keys texts by content, so a text first seen as a reply keeps reply brightness wherever the same text was narration, and a transformer from another extension that runs first and rewrites the text hides it from this one.
- Links keep their link color, and a few words stay bright where the check rejects a block (for example a link with a title). In about 3,300 narration texts from recent sessions, about 0.8% of visible characters stayed outside the tone, mostly list bullets and table borders.
- The first draw of a very long narration text can take tens of milliseconds while the checks run. Results are cached per text, width and tone.

## Enforced by
`packages/extensions/tool-activity-renderer/extensions/tool-activity-renderer/narration.test.ts` ("counts the text of a message that calls a tool as narration, and only that") — pins narration classification and the checked tone rewrite.

## Source
- Session: user report of "thinking not grayed out" in a manifest-dev session screenshot. The session records showed the bright paragraphs were `text` blocks in tool-calling messages.
- Related: none.
