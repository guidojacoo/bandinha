import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEml } from "../src/infra/transport/outbox";

/**
 * The other side of the conversation.
 *
 * Reads what the agent wrote to the outbox and answers it, so the whole loop
 * — classification, objection handling, escalation, stage transitions — runs
 * end to end without a mail server or a real person.
 *
 * Every script is **finite**. That is not tidiness, it is a bug fix: an
 * earlier version had buyers who always replied, so a won deal was dragged
 * back to an open stage by the next reply and re-closed itself on every tick,
 * for as long as the orchestrator was left running. A buyer who runs out of
 * things to say is what makes the demo terminate.
 *
 * The replies deliberately include the hard cases rather than the flattering
 * ones: a flat no, an opt-out, an incumbent objection phrased as a question
 * (which an earlier classifier read as a rejection and marked the deal lost),
 * and a commitment the agent must refuse to close by itself.
 */

const OUTBOX = process.env.OUTBOX_DIR ?? "./outbox";
const INBOX = process.env.INBOX_DIR ?? "./inbox";

interface BuyerScript {
  /** Address the agent will have written to. */
  email: string;
  name: string;
  /** One reply per inbound message, in order. Empty string means silence. */
  replies: string[];
  note: string;
}

export const buyers: BuyerScript[] = [
  {
    email: "lena.hoffman@fableworks.test",
    name: "Lena Hoffman",
    note: "The good path: an incumbent objection, then a meeting, then a commitment the agent must escalate.",
    replies: [
      "We already use Datadog for this. What would you actually add on top of that?",
      "That's a fair point about the burn rate. Happy to chat — what times suit you Thursday or Friday?",
      "Good call, that was useful. Send over the contract and we'll get it signed this week.",
    ],
  },
  {
    email: "p.almeida@meridianpay.test",
    name: "Paulo Almeida",
    note: "Asks for a price. The agent must escalate rather than invent a number.",
    replies: [
      "This is relevant for us. What does pricing look like for a team of 30?",
    ],
  },
  {
    email: "sofie@atlasgrid.test",
    name: "Sofie Lund",
    note: "A deferral. The cadence must stop and not treat it as a rejection.",
    replies: [
      "Not a priority this quarter, we're mid-migration. Try me again after June.",
    ],
  },
  {
    email: "eoin.murphy@quaypoint.test",
    name: "Eoin Murphy",
    note: "A flat no. Must be suppressed, not argued with.",
    replies: [
      "Thanks but we're not interested.",
    ],
  },
  {
    email: "m.devries@harborstack.test",
    name: "Marijke de Vries",
    note: "An opt-out. Must be suppressed globally and permanently, immediately.",
    replies: [
      "Please remove me from your list and do not contact me again.",
    ],
  },
];

const FOOTER_SEPARATOR = "\n\nOn an earlier date, the sender wrote:\n> ";

async function main(): Promise<void> {
  await mkdir(OUTBOX, { recursive: true });
  await mkdir(INBOX, { recursive: true });
  const answered = join(OUTBOX, "answered");
  await mkdir(answered, { recursive: true });

  const files = (await readdir(OUTBOX)).filter((f) => f.endsWith(".eml")).sort();
  if (files.length === 0) {
    console.log(`Nothing in ${OUTBOX} to answer yet. Run the agent first.`);
    return;
  }

  // How many replies each buyer has already used, so scripts stay finite
  // across invocations.
  const used = await countUsedReplies();
  let written = 0;
  let silent = 0;

  for (const file of files) {
    const path = join(OUTBOX, file);
    const message = parseEml(await readFile(path, "utf8"));
    await rename(path, join(answered, file)).catch(() => {});
    if (!message) continue;

    const buyer = buyers.find((b) => b.email === message.to.toLowerCase());
    if (!buyer) {
      silent += 1;
      continue;
    }

    const index = used.get(buyer.email) ?? 0;
    const reply = buyer.replies[index];
    if (!reply) {
      // Out of script. This is what lets the demo finish.
      silent += 1;
      continue;
    }
    used.set(buyer.email, index + 1);

    const quoted = message.body.split("\n").slice(0, 4).join("\n> ");
    const headers = [
      `Message-ID: <${randomUUID()}@${buyer.email.split("@")[1]}>`,
      `Date: ${new Date().toUTCString()}`,
      `From: "${buyer.name}" <${buyer.email}>`,
      `To: ${message.from}`,
      `Subject: Re: ${message.subject}`,
      message.messageId ? `In-Reply-To: ${message.messageId}` : "",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
    ].filter(Boolean);

    // The quoted original is included on purpose: it contains our own footer,
    // and the word "unsubscribe" in it used to make every single reply
    // classify as an opt-out.
    //
    // The blank line between headers and body is assembled explicitly. An
    // earlier version put "" in the array above and then filtered empty
    // entries to drop the optional In-Reply-To, which removed the separator
    // too and glued the reply onto the header block.
    const eml = `${headers.join("\r\n")}\r\n\r\n${reply}${FOOTER_SEPARATOR}${quoted}`;

    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}__reply__${buyer.email.replace(/[^a-z0-9.@-]/gi, "_")}.eml`;
    await writeFile(join(INBOX, name), `${eml}\r\n`, "utf8");
    written += 1;
    console.log(`  ${buyer.email} → "${reply.slice(0, 72)}${reply.length > 72 ? "…" : ""}"`);
  }

  console.log(`\n${written} reply(ies) written to ${INBOX}. ${silent} message(s) left unanswered (buyer out of script, or not a scripted buyer).`);
}

/** Replies already written, counted from the inbox and its processed folder. */
async function countUsedReplies(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const dir of [INBOX, join(INBOX, "processed")]) {
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.includes("__reply__")) continue;
      const buyer = buyers.find((b) => file.includes(b.email.replace(/[^a-z0-9.@-]/gi, "_")));
      if (buyer) counts.set(buyer.email, (counts.get(buyer.email) ?? 0) + 1);
    }
  }
  return counts;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
