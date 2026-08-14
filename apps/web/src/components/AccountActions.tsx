"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AccountActions() {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function exportData() {
    const res = await fetch("/api/account/export");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `h59-health-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAccount() {
    if (!confirm("Permanently delete your account and all synced health data? This cannot be undone.")) return;
    if (!confirm("Really sure? Type OK to confirm one more time.")) return;
    setDeleting(true);
    await fetch("/api/account/delete", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
      <button className="btn btn-secondary" onClick={exportData}>Export all my data</button>
      <button className="btn btn-danger" onClick={deleteAccount} disabled={deleting}>
        {deleting ? "Deleting…" : "Delete account"}
      </button>
    </div>
  );
}
