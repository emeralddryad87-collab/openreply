import { REPLY_GUIDE_SOURCE } from "@/lib/triage/reply-guide.generated";

/**
 * The owner's reply guide, as the model reads it.
 *
 * reply-guide.md is where the owner's side of every reply is written down: how
 * he talks, what each fixed situation calls for, the questions he has answered
 * once and for all, and what only he may answer. It is the one place to change
 * any of that. It is handed to the model with every request, so it stays
 * short: each thousand characters is paid for on every message.
 *
 * Why the standing answers are there at all: a model answering from its own
 * memory about plans, prices and versions gets them wrong, and a wrong answer
 * goes out under the owner's name. So those few facts are written down once,
 * checked, and are the only thing the model may say on the subject.
 *
 * What the guide does not hold is what the app does: when a link is sent
 * again, who counts as a follower, how long a reply waits. Those are code.
 */

/** The guide's sections, by the heading each one is written under. */
export const GUIDE_SECTIONS = {
  tone: "語氣",
  situations: "固定的幾種情況",
  answers: "常見問題",
  ownerOnly: "只有我本人回",
} as const;

export type GuideSection = keyof typeof GUIDE_SECTIONS;

// Everything from this heading on is for the people who maintain the guide
// (where each fact was checked, how to change the file), not for the model.
const NOTES_HEADING = /^## 附註/m;

/** The part of a guide the model reads: everything above the notes. */
export function guideForModel(source: string): string {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const notes = text.search(NOTES_HEADING);
  return (notes === -1 ? text : text.slice(0, notes)).trim();
}

/** One section of a guide, heading included; empty when the guide has none. */
export function sectionOf(guide: string, heading: string): string {
  const lines = guide.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n").trim();
}

export const REPLY_GUIDE = guideForModel(REPLY_GUIDE_SOURCE);

// Who "I" is: the guide is written in the owner's first person.
const INTRODUCTION = "【回覆指南】下面是創作者本人寫的。文中的「我」就是他；「交給我」是交給他本人回。";

/**
 * The guide as the last part of a system prompt, cut down to the sections that
 * request needs: a model sorting a message has no use for how a fixed line is
 * worded, and one wording a fixed line has no use for the standing answers.
 */
export function guideBlock(sections: GuideSection[]): string {
  const parts = sections
    .map((section) => sectionOf(REPLY_GUIDE, GUIDE_SECTIONS[section]))
    .filter(Boolean);
  return `${INTRODUCTION}\n\n${parts.join("\n\n")}`;
}

/**
 * The guide as one more "page" for the link check: an address the owner wrote
 * into his own guide may be sent, like an address on a page he published.
 */
export const GUIDE_AS_PAGE = { title: "回覆指南", content: REPLY_GUIDE };
