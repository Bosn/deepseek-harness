# Agent Note: Byte-bounded history pages

Status: implemented

English | [中文](2026-08-25-byte-bounded-history-pages.zh.md)

## Problem

Opening the Web GUI for a huge Session can require one history window of several megabytes across tens of thousands of events (one observed Session: about 5.8 MB and 16,000 events with older history available). Message-count pagination alone does not bound transfer, JSON parsing, or Client folding cost because message payloads vary by orders of magnitude. A large opening window can therefore prevent any conversation from rendering, while a similarly large older page can break scroll-back.

## Decision

- `SessionController` validates `historyPageMaxBytes` as a natural number with a 2 MiB default; `0` disables the bound. The controller passes the resolved value to `SessionHistoryController`, so every deployment can tune the limit from `cordis.yml` without changing the Remote interface or Client.
- `SessionHistoryController` applies the bound after count pagination and packed-record encoding. `session.page` prices the complete Connection JSON response (`server-response`, the standard Web client's 36-byte UUID RPC id, success result, and page value); the opening `session.follow` snapshot prices the complete Gateway stream JSON message (`item`, the standard Web client's 36-byte UUID stream id, and snapshot value). Both calculations include record delimiters and UTF-8 serialization plus every non-record field. The opening calculation therefore includes the Session header and projection baseline. Raw or custom carriers with other correlation-id lengths are outside this complete-carrier guarantee.
- An oversized window loses oldest whole append-message groups from its head. Group starts come from `sourceEventSeqs`; packed Assistant chunk rows and tool companions remain with their message, including when the cut sequence falls inside a packed row. The newest group remains whole even when it alone exceeds the budget, because an over-budget useful page is preferable to an empty page. If the opening projection baseline prevents that group from fitting, the snapshot is recalculated without the indivisible baseline; the Client already treats an absent baseline as no projection reset.
- `hasMore` is true whenever count pagination or byte trimming left an older prefix. The retained records remain one contiguous sequence range with the window tail unchanged, so `RemoteJournalStream` can continue paging backward through `session.page`. Ordinary Sessions and direct subagent addresses use the same path and bound.

## Alternatives considered

**Count-only pages.** Rejected: message payloads vary by orders of magnitude, so a fixed message count cannot bound response bytes; the observed Session tail weighed about 5.8 MB.

**A smaller fixed default.** Rejected: observed single message groups reach about 700 KB; 2 MiB keeps several nearby exchanges visible while staying far below browser parse cost.

**Mid-message cuts.** Rejected: splitting a packed chunk run or tool companion from its message would break the append-surface grouping that rendering relies on.

**Client-side truncation.** Rejected: the Client must not drop or synthesize history; model-visible speech belongs to durable, server-owned events.

## Verification

Session Controller tests cover exact-budget trimming of the complete Connection response, UTF-8 multibyte accounting, a `sourceEventSeqs` cut that retains a packed chunk row, an oversized newest packed group, `0` disabling the bound, omission of an oversized projection baseline from the complete Gateway stream item, the Client accepting that blockless opening, and Config default and natural-number validation. No keyless snapshot accompanies this behavior: carrier byte accounting does not alter model-visible transcript output, and the snapshot lanes do not exercise the browser history transport.

## Consequences

Opening a huge Session serves a bounded recent journal window, and scroll-back walks the complete log through bounded pages. Deployments can raise `historyPageMaxBytes` or set it to `0`. A carrier message can exceed the budget only for its newest indivisible message group or a record-only window with no message pivot.

## Supersession audit

No active note is archived or deleted. [Bound request-size and stalled-stream recovery](2026-08-21-request-size-timeout-recovery.md) owns provider request recovery; this note owns Session Controller history response bounds.
