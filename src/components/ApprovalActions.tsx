"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ApprovalActions({ messageId }: { messageId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);

  async function act(action: "approve" | "discard") {
    setBusy(action);
    try {
      await fetch(`/api/messages/${messageId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="btn btn-sm" disabled={busy !== null} onClick={() => act("approve")}>
        {busy === "approve" ? "Sending…" : "Approve & send"}
      </button>
      <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => act("discard")}>
        Discard
      </button>
    </div>
  );
}

export function DealActions({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(action: "won" | "lost") {
    setBusy(true);
    try {
      await fetch(`/api/deals/${dealId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: action === "lost" ? "Closed by the operator." : undefined }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="btn btn-sm" disabled={busy} onClick={() => act("won")}>Mark won</button>
      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act("lost")}>Mark lost</button>
    </div>
  );
}
